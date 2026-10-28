/**
 * routes/kmSync.js - Partición 7: Extractor de Kilómetros y Viajes (Sincronizador Autónomo)
 * 
 * Extrae la planilla de Kilómetros desde Google Sheets ('KM'!A1:V), normaliza nombres con
 * la arquitectura multi-capa y Fuzzy Resolver canónica de n8n (basesOrgTractores01),
 * agrupa en buckets mensuales (Rollup), evalúa Diffing O(1) contra Supabase y ejecuta
 * UPSERT atómico parametrizado por lotes (Chunks de 200) en public.choferes_km_mensual.
 */

const express = require('express');
const db = require('../utils/db');
const { 
    fetchRango, 
    ID_SHEET_KILOMETROS 
} = require('../utils/shared');

// ==============================================================
// 1. ARQUITECTURA DE NORMALIZACIÓN MULTI-CAPA Y FUZZY RESOLVER
// ==============================================================
function restoreEnie(str) {
    if (!str) return { restored: '', hadHashOrMojibake: false };
    const orig = String(str).trim();
    const hadHashOrMojibake = /#|Ã‘|Ã±|\uFFFD/.test(orig);
    const restored = orig
        .replace(/Ã‘|Ã±|\uFFFD/g, 'Ñ')
        .replace(/#/g, 'Ñ')
        .replace(/\s+/g, ' ')
        .trim();
    return { restored, hadHashOrMojibake };
}

function sanitizeNameAscii(str) {
    if (!str) return '';
    return restoreEnie(str).restored
        .replace(/[ñÑ]/g, 'N')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getSignificantTokens(str) {
    const stopWords = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y', 'SAN', 'SANTA']);
    return sanitizeNameAscii(str).split(' ').filter(t => t && !stopWords.has(t));
}

function sortedTokenKey(str) {
    return getSignificantTokens(str).slice().sort().join(' ');
}

function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= n; j++) {
            const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        const tmp = prev; prev = curr; curr = tmp;
    }
    return prev[n];
}

function tokenSimilarity(t1, t2) {
    if (t1 === t2) return 1.0;
    const maxLen = Math.max(t1.length, t2.length);
    return maxLen === 0 ? 1.0 : 1.0 - levenshtein(t1, t2) / maxLen;
}

const KNOWN_ALIASES = {
    'ACUNA SANTIAGO': 'ACUÑA RAFAEL SANTIAGO',
    'AGUERO ALEXIS': 'AGUERO ALEXIS DAMIAN',
    'ALANIZ CRISTIAN PAULO': 'ALANIZ CRISTIAN PAULO',
    'MENDOZA ERWIN GONZALO': 'MENDOZA REYES ERWIN GONZALO',
    'POO NARVAEZ JAIRO': 'POO NARVAEZ JAIRO BERNABE',
    'SANDOVAL DARIO': 'SANDOVAL REYES CRISTIAN EDUARDO',
    'LEONARDO ARIEL GUEVARA': 'GUEVARA LEONARDO A',
    'GUEVARA LEONARDO ARIEL': 'GUEVARA LEONARDO A',
    'RAMOS GONZALO DAVID': 'RAMOS DAVID GONZALO',
    'RAMOS DAVID GONZALO': 'RAMOS DAVID GONZALO'
};

function parseFecha(val) {
    if (!val) return null;
    const clean = String(val).split(' - ')[0].trim();
    const parts = clean.split(/[\/\-]/);
    if (parts.length === 3) {
        let y = parseInt(parts[2], 10);
        if (y < 100) y += 2000;
        if (y < 2020 || y > 2030) return null;
        const m = String(parseInt(parts[1], 10)).padStart(2, '0');
        const d = String(parseInt(parts[0], 10)).padStart(2, '0');
        if (!isNaN(y) && !isNaN(parseInt(m, 10)) && !isNaN(parseInt(d, 10))) {
            return `${y}-${m}-${d}`;
        }
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(clean)) {
        const y = parseInt(clean.substring(0, 4), 10);
        if (y >= 2020 && y <= 2030) return clean.substring(0, 10);
    }
    return null;
}

function parseNum(val) {
    if (!val) return 0;
    const clean = String(val).replace(/,/g, '.').replace(/[^0-9.-]/g, '');
    const n = parseFloat(clean);
    return isNaN(n) ? 0 : n;
}

const mesesMap = {
    '01': 'Ene', '02': 'Feb', '03': 'Mar', '04': 'Abr', '05': 'May', '06': 'Jun',
    '07': 'Jul', '08': 'Ago', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dic'
};

/**
 * Función central de sincronización de Partición 7 (Kilómetros)
 * Idéntica al motor de basesOrgTractores01 de n8n local.
 */
async function sincronizarKmDesdeSheets(cacheDatosGlobales = null, io = null, ioDash = null) {
    const t0 = Date.now();
    const spreadsheetId = process.env.ID_SHEET_KM || process.env.SHEET_KM_ID || ID_SHEET_KILOMETROS || '1d5dIS1rbOg3q7D0A4eDA_mcdSy1Yfwfx6M6sZ8Aenzw';
    
    console.log(`🔄 [Partición 7 Auto-Sync] Sincronizando Kilómetros desde Google Sheets (${spreadsheetId})...`);

    if (!db.isConfigured()) {
        console.warn("⚠️ [Partición 7] Base de datos no configurada en db.js");
        return { success: false, error: "DB not configured" };
    }

    // 1. Catálogo de Choferes, Formaciones y Estado Preexistente
    const pgDataRes = await db.query(`
        SELECT 
          (SELECT json_agg(json_build_object('id', id, 'nombre', UPPER(TRIM(nombre)), 'legajo', legajo)) 
           FROM public.choferes WHERE nombre IS NOT NULL) AS choferes,
          (SELECT json_agg(json_build_object('id', u.id, 'n_ute', u.n_ute, 'tractor', UPPER(TRIM(t.patente)), 'semi', UPPER(TRIM(s.patente)))) 
           FROM public.unidades u 
           LEFT JOIN public.tractores t ON u.tractor_id = t.id 
           LEFT JOIN public.semis s ON u.semi_id = s.id) AS formaciones,
          (SELECT json_agg(json_build_object('chofer_id', chofer_id, 'mes_tab', mes_tab, 'km_mes_total', km_mes_total::float, 'cant_viajes', cant_viajes, 'dias_km', dias_km)) 
           FROM public.choferes_km_mensual 
           WHERE anio >= EXTRACT(YEAR FROM CURRENT_DATE) - 1) AS preexistentes;
    `);

    const choferes = pgDataRes.rows[0]?.choferes || [];
    const formaciones = pgDataRes.rows[0]?.formaciones || [];
    const preexistentes = pgDataRes.rows[0]?.preexistentes || [];

    const tractorMap = new Map();
    const semiMap = new Map();
    const uteMap = new Map();

    formaciones.forEach(f => {
        if (!f) return;
        if (f.tractor) {
            const trClean = f.tractor.replace(/[^A-Z0-9]/g, '');
            tractorMap.set(trClean, f);
        }
        if (f.semi) {
            const seClean = f.semi.replace(/[^A-Z0-9]/g, '');
            semiMap.set(seClean, f);
        }
        if (f.n_ute) {
            const uteClean = String(f.n_ute).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
            uteMap.set(uteClean, f);
        }
    });

    // Indexar choferes catalogados con arquitectura multi-capa (idéntica a n8n)
    const bySanitized = new Map();
    const bySortedTokens = new Map();
    const byTokensList = [];

    choferes.forEach(c => {
        if (!c || !c.nombre) return;
        const san = sanitizeNameAscii(c.nombre);
        const sKey = sortedTokenKey(c.nombre);
        const tokens = getSignificantTokens(c.nombre);
        bySanitized.set(san, c);
        bySortedTokens.set(sKey, c);
        byTokensList.push({ chofer: c, tokens, tokenSet: new Set(tokens), mainSurname: tokens[0] });
    });

    function resolveChoferParticion1(rawName) {
        if (!rawName) return null;
        const { restored } = restoreEnie(rawName);
        const san = sanitizeNameAscii(restored);
        if (!san || san.length < 3 || san.startsWith('NO IDENTIFICADO') || san.startsWith('TOTAL') || san === 'CHOFER' || san.startsWith('PERSONAL')) return null;

        if (bySanitized.has(san)) return bySanitized.get(san);
        if (KNOWN_ALIASES[san]) {
            const aliasT = sanitizeNameAscii(KNOWN_ALIASES[san]);
            if (bySanitized.has(aliasT)) return bySanitized.get(aliasT);
        }
        const sKey = sortedTokenKey(restored);
        if (bySortedTokens.has(sKey)) return bySortedTokens.get(sKey);

        const kTokens = getSignificantTokens(restored);
        const kSet = new Set(kTokens);
        if (kTokens.length >= 2) {
            const cands = byTokensList.filter(it => {
                const surnameMatch = it.mainSurname === kTokens[0] || tokenSimilarity(it.mainSurname, kTokens[0]) >= 0.85;
                if (!surnameMatch) return false;
                const kInIt = kTokens.every(t => it.tokenSet.has(t) || Array.from(it.tokenSet).some(itT => tokenSimilarity(t, itT) >= 0.85));
                const itInK = it.tokens.every(t => kSet.has(t) || Array.from(kSet).some(kt => tokenSimilarity(t, kt) >= 0.85));
                return kInIt || itInK;
            });
            if (cands.length === 1) return cands[0].chofer;
        }

        let bestCand = null, bestSim = 0;
        for (const item of byTokensList) {
            const surnameSim = Math.max(...kTokens.map(kt => tokenSimilarity(item.mainSurname, kt)));
            if (surnameSim < 0.72) continue;
            const shorter = kTokens.length <= item.tokens.length ? kTokens : item.tokens;
            const longer = kTokens.length <= item.tokens.length ? item.tokens : kTokens;
            if (shorter.length === 0) continue;
            let sumSim = 0;
            for (const st of shorter) {
                let maxS = 0;
                for (let i = 0; i < longer.length; i++) {
                    const s = tokenSimilarity(st, longer[i]);
                    if (s > maxS) maxS = s;
                }
                sumSim += maxS;
            }
            const score = sumSim / shorter.length;
            if (score > bestSim) { bestSim = score; bestCand = item.chofer; }
        }
        if (bestSim >= 0.80 && bestCand) return bestCand;
        return null;
    }

    const resolveCache = new Map();
    function resolveChoferCached(rawName) {
        if (!rawName) return null;
        if (resolveCache.has(rawName)) return resolveCache.get(rawName);
        const resolved = resolveChoferParticion1(rawName);
        resolveCache.set(rawName, resolved);
        return resolved;
    }

    const preMap = new Map();
    preexistentes.forEach(p => {
        if (p && p.chofer_id && p.mes_tab) {
            preMap.set(`${p.chofer_id}__${p.mes_tab}`, p);
        }
    });

    // 2. Leer Google Sheet (Rango A1:V dinámico para cubrir todas las columnas)
    const rawRows = await fetchRango(spreadsheetId, "'KM'!A1:V");
    if (!rawRows || rawRows.length < 2) {
        console.warn(`⚠️ [Partición 7] Hoja 'KM' vacía o inaccesible.`);
        return { success: true, message: "Sin datos en planilla KM", totalBuckets: 0, modificados: 0 };
    }

    const headers = rawRows[0] || [];
    const normHeader = (h) => String(h || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
    const colMap = {};
    headers.forEach((h, idx) => {
        const k = normHeader(h);
        if (k && colMap[k] === undefined) colMap[k] = idx;
    });

    const colFecha = colMap['fecha'] ?? 1;
    const colChofer = colMap['chofer'] ?? 2;
    const colDominio = colMap['dominio'] ?? colMap['tractor'] ?? 0;
    const colKmTot = colMap['kmtotales'] ?? (colMap['cargas'] !== undefined && colMap['cargas'] === 16 ? 17 : 17);
    const colKmAlt = colMap['kilometros'] ?? colMap['km'] ?? 10;
    const colHr = colMap['nhojaderuta'] ?? colMap['hojaderuta'] ?? colMap['hr'] ?? 20;
    const colSemi = colMap['semi'] ?? 19;

    console.log(`   📊 [KM Mapeo] Columnas: Fecha=${colFecha}, Chofer=${colChofer}, Dominio=${colDominio}, KmTot=${colKmTot}, KmAlt=${colKmAlt}, HR=${colHr}, Semi=${colSemi}`);

    const buckets = new Map();
    const inconsistencias = [];
    const cisternasMap = new Map();
    let fuzzyMatchesCount = 0;

    for (let rIdx = 1; rIdx < rawRows.length; rIdx++) {
        const row = rawRows[rIdx];
        if (!row || row.length === 0) continue;

        const rawChofer = String(row[colChofer] || '').trim();
        if (!rawChofer || ['1', '0', '-', 'S/A', 'VACANTE', 'SIN CHOFER'].includes(rawChofer.toUpperCase())) continue;

        const rawFecha = row[colFecha];
        const fechaIso = parseFecha(rawFecha);
        if (!fechaIso) continue;

        const fechaParts = fechaIso.split('-');
        const anio = parseInt(fechaParts[0], 10);
        if (anio < 2024 || anio > 2030) continue;

        const mm = fechaParts[1];
        const mesNumero = parseInt(mm, 10);
        const mesAbrev = mesesMap[mm] || 'Mes';
        const yy = String(anio).slice(-2);
        const mesTab = `${mesAbrev}-${yy}`;

        // Prioridad Km Totales (col 17) -> Fallback Kilómetros (col 10)
        const kmTot = parseNum(row[colKmTot]);
        const kmAlt = parseNum(row[colKmAlt]);
        const km = kmTot > 0 ? kmTot : kmAlt;
        const hr = colHr !== undefined && row[colHr] !== undefined ? String(row[colHr]).trim() : '';

        // Descartar filas vacías sin KM ni Hoja de Ruta
        if (km <= 0 && !hr) continue;

        const rawDominio = String(row[colDominio] || '').trim().toUpperCase();
        const dominio = rawDominio || null;
        const rawSemi = colSemi !== undefined && row[colSemi] !== undefined ? String(row[colSemi] || '').trim().toUpperCase() : null;
        const semi = rawSemi || null;

        const domClean = dominio ? dominio.replace(/[^A-Z0-9]/g, '') : '';
        const semiClean = semi ? semi.replace(/[^A-Z0-9]/g, '') : '';

        const formacion = (domClean && tractorMap.get(domClean)) || (semiClean && semiMap.get(semiClean)) || null;
        const idUnidad = formacion ? formacion.id : null;
        const nUte = formacion ? formacion.n_ute : null;

        const matchedChofer = resolveChoferCached(rawChofer);
        const choferId = matchedChofer ? matchedChofer.id : null;

        if (!choferId) {
            inconsistencias.push({
                fecha: fechaIso,
                chofer: rawChofer,
                dominio: dominio || 'S/D',
                km: km,
                hoja_ruta: hr,
                motivo: 'CHOFER_NO_CATALOGADO',
                timestamp: new Date().toISOString()
            });
            continue;
        }

        if (matchedChofer.nombre !== rawChofer.trim().toUpperCase()) {
            fuzzyMatchesCount++;
        }

        const bucketKey = `${choferId}__${mesTab}`;
        if (!buckets.has(bucketKey)) {
            buckets.set(bucketKey, {
                chofer_id: choferId,
                mes_tab: mesTab,
                anio: anio,
                mes_numero: mesNumero,
                km_mes_total: 0,
                cant_viajes: 0,
                dias_km: {},
                fechasList: []
            });
        }

        const b = buckets.get(bucketKey);
        b.km_mes_total = Math.round((b.km_mes_total + km) * 100) / 100;
        b.cant_viajes += 1;

        if (!b.dias_km[fechaIso]) {
            b.dias_km[fechaIso] = {
                km: 0,
                hr: hr || '',
                tractor: dominio || null,
                semi: semi || null,
                id_unidad: idUnidad || null,
                n_ute: nUte || null
            };
            b.fechasList.push(fechaIso);
        }
        b.dias_km[fechaIso].km = Math.round((b.dias_km[fechaIso].km + km) * 100) / 100;
        if (hr && !b.dias_km[fechaIso].hr.includes(hr)) {
            b.dias_km[fechaIso].hr = b.dias_km[fechaIso].hr ? `${b.dias_km[fechaIso].hr}, ${hr}` : hr;
        }
        if (idUnidad && !b.dias_km[fechaIso].id_unidad) b.dias_km[fechaIso].id_unidad = idUnidad;
        if (nUte && !b.dias_km[fechaIso].n_ute) b.dias_km[fechaIso].n_ute = nUte;

        // Registro para cisternas_km
        if (semi && km > 0) {
            const cKey = `${fechaIso}__${dominio || ''}__${semi}__${hr || ''}`;
            if (!cisternasMap.has(cKey)) {
                cisternasMap.set(cKey, {
                    fecha: fechaIso,
                    cisterna_patente: semi,
                    tractor_patente: dominio,
                    id_unidad: idUnidad,
                    id_chofer: choferId,
                    km_totales: km,
                    hoja_ruta: hr || null
                });
            }
        }
    }

    let omitidosCount = 0;
    let modificadosCount = 0;
    const itemsParaUpsert = [];

    for (const [key, b] of buckets.entries()) {
        b.km_mes_total = Math.round(b.km_mes_total * 100) / 100;

        const sortedFechas = b.fechasList.sort();
        const rangos = [];
        let curRango = null;

        sortedFechas.forEach(fStr => {
            const curDate = new Date(fStr + 'T12:00:00Z');
            if (!curRango) {
                curRango = { desde: fStr, hasta: fStr, dias: 1, km: b.dias_km[fStr].km };
            } else {
                const prevDate = new Date(curRango.hasta + 'T12:00:00Z');
                const diffDays = Math.round((curDate - prevDate) / (1000 * 3600 * 24));
                if (diffDays === 1) {
                    curRango.hasta = fStr;
                    curRango.dias += 1;
                    curRango.km = Math.round((curRango.km + b.dias_km[fStr].km) * 100) / 100;
                } else {
                    rangos.push(curRango);
                    curRango = { desde: fStr, hasta: fStr, dias: 1, km: b.dias_km[fStr].km };
                }
            }
        });
        if (curRango) rangos.push(curRango);
        b.rangos = rangos;

        const pre = preMap.get(key);
        if (pre) {
            const sameKm = Math.abs(pre.km_mes_total - b.km_mes_total) < 0.01;
            const sameTrips = pre.cant_viajes === b.cant_viajes;
            
            let sameDays = false;
            const preDays = pre.dias_km || {};
            const bDays = b.dias_km || {};
            const bDayKeys = Object.keys(bDays);
            const preDayKeys = Object.keys(preDays);

            if (bDayKeys.length === preDayKeys.length) {
                sameDays = bDayKeys.every(k => {
                    const pd = preDays[k];
                    const bd = bDays[k];
                    return pd && Math.abs((pd.km || 0) - (bd.km || 0)) < 0.01 && (pd.hr || '') === (bd.hr || '');
                });
            }

            if (sameKm && sameTrips && sameDays) {
                omitidosCount++;
                continue;
            }
        }

        modificadosCount++;
        itemsParaUpsert.push({
            chofer_id: b.chofer_id,
            mes_tab: b.mes_tab,
            anio: b.anio,
            mes_numero: b.mes_numero,
            km_mes_total: b.km_mes_total,
            cant_viajes: b.cant_viajes,
            dias_km: b.dias_km,
            rangos: b.rangos
        });
    }

    if (itemsParaUpsert.length > 0) {
        const chunkSize = 200;
        for (let i = 0; i < itemsParaUpsert.length; i += chunkSize) {
            const chunk = itemsParaUpsert.slice(i, i + chunkSize);
            await db.query(`
                INSERT INTO public.choferes_km_mensual (
                    chofer_id, mes_tab, anio, mes_numero, km_mes_total, cant_viajes, dias_km, rangos, actualizado_el
                )
                SELECT
                    (x->>'chofer_id')::uuid,
                    x->>'mes_tab',
                    (x->>'anio')::int,
                    (x->>'mes_numero')::int,
                    (x->>'km_mes_total')::numeric,
                    (x->>'cant_viajes')::int,
                    COALESCE(x->'dias_km', '{}'::jsonb),
                    COALESCE(x->'rangos', '[]'::jsonb),
                    NOW()
                FROM jsonb_array_elements($1::jsonb) AS x
                ON CONFLICT (chofer_id, mes_tab)
                DO UPDATE SET
                    km_mes_total = GREATEST(choferes_km_mensual.km_mes_total, EXCLUDED.km_mes_total),
                    cant_viajes = EXCLUDED.cant_viajes,
                    dias_km = EXCLUDED.dias_km,
                    rangos = EXCLUDED.rangos,
                    actualizado_el = NOW();
            `, [JSON.stringify(chunk)]);
        }
        console.log(`✅ [Partición 7] Upsert completado en Supabase: ${itemsParaUpsert.length} buckets actualizados (${omitidosCount} omitidos idénticos) en ${Date.now() - t0}ms.`);
    } else {
        console.log(`✅ [Partición 7] Sin cambios pendientes. Todos los ${omitidosCount} buckets idénticos (Diffing O(1) Zero Egress).`);
    }

    if (cisternasMap.size > 0) {
        try {
            const cisternasArr = Array.from(cisternasMap.values());
            const cChunkSize = 250;
            for (let i = 0; i < cisternasArr.length; i += cChunkSize) {
                const cChunk = cisternasArr.slice(i, i + cChunkSize);
                await db.query(`
                    INSERT INTO public.cisternas_km (
                        fecha, cisterna_patente, tractor_patente, id_unidad, id_chofer, km_totales, hoja_ruta, origen_dato, actualizado_el
                    )
                    SELECT
                        (x->>'fecha')::date,
                        x->>'cisterna_patente',
                        x->>'tractor_patente',
                        (x->>'id_unidad')::uuid,
                        (x->>'id_chofer')::uuid,
                        (x->>'km_totales')::numeric,
                        x->>'hoja_ruta',
                        'sheets_km',
                        NOW()
                    FROM jsonb_array_elements($1::jsonb) AS x
                    ON CONFLICT (fecha, tractor_patente, COALESCE(cisterna_patente, ''), COALESCE(hoja_ruta, ''))
                    DO UPDATE SET
                        km_totales = EXCLUDED.km_totales,
                        id_unidad = COALESCE(EXCLUDED.id_unidad, cisternas_km.id_unidad),
                        id_chofer = COALESCE(EXCLUDED.id_chofer, cisternas_km.id_chofer),
                        actualizado_el = NOW();
                `, [JSON.stringify(cChunk)]);
            }
            console.log(`✅ [Partición 7] Sincronización en public.cisternas_km completada (${cisternasArr.length} registros).`);
        } catch (cErr) {
            console.warn(`⚠️ [Partición 7] Advertencia en cisternas_km upsert:`, cErr.message);
        }
    }

    return {
        success: true,
        total_buckets: buckets.size,
        modificados: itemsParaUpsert.length,
        omitidos_identicos: omitidosCount,
        normalizaciones_fuzzy: fuzzyMatchesCount,
        inconsistencias: inconsistencias.length,
        duracion_ms: Date.now() - t0
    };
}

module.exports = function(cacheDatosGlobales, io, ioDash) {
    const router = express.Router();

    // POST /api/sync/km o /api/sync/km/sync
    router.post(['/', '/sync', '/sync-supabase'], async (req, res) => {
        try {
            const resultado = await sincronizarKmDesdeSheets(cacheDatosGlobales, io, ioDash);
            res.json(resultado);
        } catch (err) {
            console.error('❌ Error en sincronización de Kilómetros:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // GET /api/sync/km/status
    router.get('/status', (req, res) => {
        res.json({
            servicio: 'Partición 7: Sincronizador de Kilómetros y Viajes (Google Sheets -> Supabase)',
            estado: 'activo',
            spreadsheetId: process.env.ID_SHEET_KM || process.env.SHEET_KM_ID || ID_SHEET_KILOMETROS || '1d5dIS1rbOg3q7D0A4eDA_mcdSy1Yfwfx6M6sZ8Aenzw'
        });
    });

    return router;
};

module.exports.sincronizarKmDesdeSheets = sincronizarKmDesdeSheets;
