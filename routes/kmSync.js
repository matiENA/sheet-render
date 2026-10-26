/**
 * routes/kmSync.js - Partición 7: Extractor de Kilómetros y Viajes (Sincronizador Autónomo)
 * 
 * Extrae la planilla de Kilómetros desde Google Sheets (A1:T), normaliza nombres con algoritmo
 * multi-capa (mojibake restore + fuzzy Soundex), agrupa en buckets mensuales (Rollup),
 * evalúa Diffing O(1) contra Supabase y ejecuta UPSERT atómico en public.choferes_km_mensual.
 */

const express = require('express');
const db = require('../utils/db');
const { 
    fetchRango, 
    ID_SHEET_KILOMETROS 
} = require('../utils/shared');

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

function soundex(s) {
    if (!s) return '';
    const clean = s.toUpperCase().replace(/[^A-Z]/g, '');
    if (!clean) return '';
    const map = {
        B:1, F:1, P:1, V:1,
        C:2, G:2, J:2, K:2, Q:2, S:2, X:2, Z:2,
        D:3, T:3,
        L:4,
        M:5, N:5,
        R:6
    };
    let out = clean[0];
    let prev = map[clean[0]] || 0;
    for (let i = 1; i < clean.length && out.length < 4; i++) {
        const code = map[clean[i]] || 0;
        if (code !== 0 && code !== prev) {
            out += code;
        }
        prev = code;
    }
    return (out + '000').slice(0, 4);
}

function parseFecha(val) {
    if (!val) return null;
    const clean = String(val).split(' - ')[0].trim();
    const parts = clean.split(/[\/\-]/);
    if (parts.length === 3) {
        let y = parseInt(parts[2], 10);
        if (y < 100) y += 2000;
        const m = String(parseInt(parts[1], 10)).padStart(2, '0');
        const d = String(parseInt(parts[0], 10)).padStart(2, '0');
        if (!isNaN(y) && !isNaN(parseInt(m, 10)) && !isNaN(parseInt(d, 10))) {
            return `${y}-${m}-${d}`;
        }
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(clean)) return clean.substring(0, 10);
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
 */
async function sincronizarKmDesdeSheets(cacheDatosGlobales = null, io = null, ioDash = null) {
    const t0 = Date.now();
    const spreadsheetId = process.env.ID_SHEET_KM || process.env.SHEET_KM_ID || ID_SHEET_KILOMETROS || '1d5dIS1rbOg3q7D0A4eDA_mcdSy1Yfwfx6M6sZ8Aenzw';
    
    console.log(`🔄 [Partición 7 Auto-Sync] Sincronizando Kilómetros desde Google Sheets (${spreadsheetId})...`);

    if (!db.isConfigured()) {
        console.warn("⚠️ [Partición 7] Base de datos no configurada en db.js");
        return { success: false, error: "DB not configured" };
    }

    // 1. Catálogo de Choferes y Estado Preexistente
    const pgDataRes = await db.query(`
        SELECT 
          (SELECT json_agg(json_build_object('id', id, 'nombre', UPPER(TRIM(nombre)), 'legajo', legajo)) 
           FROM public.choferes WHERE nombre IS NOT NULL) AS choferes,
          (SELECT json_agg(json_build_object('chofer_id', chofer_id, 'mes_tab', mes_tab, 'km_mes_total', km_mes_total::float, 'cant_viajes', cant_viajes, 'dias_km', dias_km)) 
           FROM public.choferes_km_mensual 
           WHERE anio >= EXTRACT(YEAR FROM CURRENT_DATE) - 1) AS preexistentes;
    `);

    const choferes = pgDataRes.rows[0]?.choferes || [];
    const preexistentes = pgDataRes.rows[0]?.preexistentes || [];

    const choferMap = new Map();
    const choferMapAscii = new Map();
    const choferSoundexMap = new Map();

    choferes.forEach(c => {
        if (!c || !c.nombre) return;
        const { restored } = restoreEnie(c.nombre);
        const upper = restored.toUpperCase();
        const ascii = sanitizeNameAscii(c.nombre);

        choferMap.set(upper, c.id);
        if (!choferMapAscii.has(ascii)) choferMapAscii.set(ascii, c.id);

        const tokens = ascii.split(' ').filter(t => t.length > 2);
        if (tokens.length >= 2) {
            const sxKey = `${soundex(tokens[0])}_${soundex(tokens[1])}`;
            if (!choferSoundexMap.has(sxKey)) choferSoundexMap.set(sxKey, c.id);
        }
    });

    const preMap = new Map();
    preexistentes.forEach(p => {
        if (p && p.chofer_id && p.mes_tab) {
            preMap.set(`${p.chofer_id}__${p.mes_tab}`, p);
        }
    });

    // 2. Leer Google Sheet (Rango A1:T)
    const rawRows = await fetchRango(spreadsheetId, "'KM'!A1:T");
    if (!rawRows || rawRows.length < 2) {
        console.warn(`⚠️ [Partición 7] Hoja 'KM' vacía o inaccesible.`);
        return { success: true, message: "Sin datos en planilla KM", totalBuckets: 0, modificados: 0 };
    }

    const headers = rawRows[0];
    const items = [];
    for (let i = 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        const obj = {};
        headers.forEach((h, hIdx) => {
            obj[h || `col_${hIdx}`] = row[hIdx] !== undefined ? row[hIdx] : '';
        });
        items.push(obj);
    }

    const buckets = new Map();
    const inconsistencias = [];
    let fuzzyMatchesCount = 0;

    for (const row of items) {
        const rawFecha = row.FECHA || row.Fecha || row.col_0;
        const rawChofer = row.CHOFER || row.Chofer || row.col_1;
        const rawDominio = String(row.TRACTOR || row.Tractor || row.DOMINIO || row.Dominio || row.col_2 || '').trim().toUpperCase();
        const rawKm = row.KM || row.Km || row.col_3;
        const rawHr = row['HOJA DE RUTA'] || row.HR || row.col_4 || '';

        const fechaIso = parseFecha(rawFecha);
        if (!fechaIso) continue;

        const fechaParts = fechaIso.split('-');
        const anio = parseInt(fechaParts[0], 10);
        const mm = fechaParts[1];
        const mesNumero = parseInt(mm, 10);
        const mesAbrev = mesesMap[mm] || 'Mes';
        const yy = String(anio).slice(-2);
        const mesTab = `${mesAbrev}-${yy}`;

        const km = parseNum(rawKm);
        const hr = String(rawHr).trim();
        const dominio = rawDominio || null;

        const { restored: nombreRestaurado } = restoreEnie(rawChofer);
        const nombreUpper = nombreRestaurado.toUpperCase();
        const nombreAscii = sanitizeNameAscii(nombreRestaurado);

        let choferId = choferMap.get(nombreUpper) || null;
        if (!choferId && choferMapAscii.has(nombreAscii)) {
            choferId = choferMapAscii.get(nombreAscii);
            fuzzyMatchesCount++;
        }

        if (!choferId) {
            const tokens = nombreAscii.split(' ').filter(t => t.length > 2);
            if (tokens.length >= 2) {
                const sxKey = `${soundex(tokens[0])}_${soundex(tokens[1])}`;
                if (choferSoundexMap.has(sxKey)) {
                    choferId = choferSoundexMap.get(sxKey);
                    fuzzyMatchesCount++;
                }
            }
        }

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
                tractor: dominio || null
            };
            b.fechasList.push(fechaIso);
        }
        b.dias_km[fechaIso].km = Math.round((b.dias_km[fechaIso].km + km) * 100) / 100;
        if (hr && !b.dias_km[fechaIso].hr.includes(hr)) {
            b.dias_km[fechaIso].hr = b.dias_km[fechaIso].hr ? `${b.dias_km[fechaIso].hr}, ${hr}` : hr;
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
        const batchJsonStr = JSON.stringify(itemsParaUpsert).replace(/'/g, "''");
        const sqlQuery = `
          DO $$
          BEGIN
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
            FROM jsonb_array_elements('${batchJsonStr}'::jsonb) AS x
            ON CONFLICT (chofer_id, mes_tab)
            DO UPDATE SET
              km_mes_total = EXCLUDED.km_mes_total,
              cant_viajes = EXCLUDED.cant_viajes,
              dias_km = EXCLUDED.dias_km,
              rangos = EXCLUDED.rangos,
              actualizado_el = NOW();
          END $$;
        `;
        await db.query(sqlQuery);
        console.log(`✅ [Partición 7] Upsert completado en Supabase: ${itemsParaUpsert.length} buckets actualizados (${omitidosCount} omitidos idénticos) en ${Date.now() - t0}ms.`);
    } else {
        console.log(`✅ [Partición 7] Sin cambios pendientes. Todos los ${omitidosCount} buckets idénticos (Diffing O(1) Zero Egress).`);
    }

    return {
        success: true,
        total_buckets: buckets.size,
        modificados: itemsParaUpsert.length,
        omitidos_identicos: omitidosCount,
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
