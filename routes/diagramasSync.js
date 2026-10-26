/**
 * routes/diagramasSync.js - Partición 5: Días Diagrama (Sincronizador Autónomo)
 * 
 * Extrae la matriz mensual de turnos y estados diarios desde Google Sheets (cabecera en fila 5,
 * choferes desde fila 6), mapea estados (trabajados, francos, vacaciones, ausencias),
 * ejecuta Diffing O(1) contra Supabase y realiza un UPSERT masivo atómico en public.diagramas.
 */

const express = require('express');
const db = require('../utils/db');
const { 
    fetchRango, 
    getTabName, 
    ID_SPREADSHEET_DIAGRAMAS, 
    getFechaArgentina,
    mesesAbrev 
} = require('../utils/shared');

function normText(str) {
    if (!str) return '';
    return String(str)
        .replace(/Ã‘|Ã±|\uFFFD/g, 'Ñ')
        .replace(/#/g, 'Ñ')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getBaseState(val) {
    if (val === undefined || val === null) return '';
    const str = String(val).trim().toUpperCase();
    if (str.includes('+')) return str.split('+')[0].trim();
    return str;
}

function contabilizarDias(diasMap) {
    let trabajados = 0, francos = 0, vacaciones = 0, ausencias = 0, inactivos = 0;
    const desglose = { enfermedad: 0, art: 0, indisposicion: 0, suspension: 0, ausencia: 0, permiso: 0, otros: 0 };
    const entries = Object.entries(diasMap || {});
    for (const [, val] of entries) {
        if (!val || val === '-' || val === '0' || val === 'NULL' || val === 'UNDEFINED' || val === '') {
            inactivos++;
            continue;
        }
        const base = getBaseState(val);
        if ((!isNaN(base) && base !== '') || base === 'O' || base === 'OPERATIVO') {
            trabajados++;
        } else if (['F', 'FSF', 'FRANCO', 'RPT'].includes(base)) {
            francos++;
        } else if (['V', 'VSF', 'VACACIONES'].includes(base)) {
            vacaciones++;
        } else if (['E', 'ART', 'IND', 'IIND', 'A', 'S', 'P', 'MED', 'SUSP', 'LIC'].some(k => base.includes(k))) {
            ausencias++;
            if (base === 'E' || base.startsWith('MED')) desglose.enfermedad++;
            else if (base === 'ART') desglose.art++;
            else if (base.startsWith('IND')) desglose.indisposicion++;
            else if (base === 'S' || base.startsWith('SUSP')) desglose.suspension++;
            else if (base === 'A') desglose.ausencia++;
            else if (base === 'P') desglose.permiso++;
            else desglose.otros++;
        } else {
            desglose.otros++;
        }
    }
    return { total_evaluados: entries.length, trabajados, francos, vacaciones, ausencias, inactivos, desglose };
}

const blacklist = new Set([
    'APELLIDO Y NOMBRE', 'PERSONAL ACTIVO', 'LEGAJO', 'CUENTA', 'SERVICIO', 
    'DIAGRAMA', 'TOTAL', 'CHOFER', 'NOMBRE', 'FECHA', 'PASIVO EN BASE', 'PASIVO', 'NOMENCLATURAS'
]);

/**
 * Función central de extracción y sincronización de Partición 5
 */
async function sincronizarDiagramasDesdeSheets(cacheDatosGlobales = null, io = null, ioDash = null, mesTabParam = null, anioParam = null) {
    const t0 = Date.now();
    const hoyAr = getFechaArgentina();
    const anio = anioParam ? parseInt(anioParam, 10) : hoyAr.getFullYear();
    const mNum = hoyAr.getMonth() + 1;
    const yy = String(anio).slice(-2);
    const defaultTab = `${mesesAbrev[hoyAr.getMonth()]}-${yy}`;
    
    const spreadsheetId = process.env.ID_SPREADSHEET_DIAGRAMAS || ID_SPREADSHEET_DIAGRAMAS || '14jgQZF0gkbT7k3mps1k3dM3qtoaseoCOUfK4PFRozKU';
    const mesTab = mesTabParam || await getTabName(spreadsheetId, 'oct', defaultTab);
    const mesNumero = mNum;
    const mesStr = String(mesNumero).padStart(2, '0');

    console.log(`🔄 [Partición 5 Auto-Sync] Sincronizando Días Diagrama (Pestaña: ${mesTab}, Año: ${anio})...`);

    if (!db.isConfigured()) {
        console.warn("⚠️ [Partición 5] Base de datos no configurada en db.js");
        return { success: false, error: "DB not configured" };
    }

    // 1. Obtener catálogo y estado preexistente
    const pgDataRes = await db.query(`
        SELECT 
          (SELECT COALESCE(json_agg(json_build_object(
              'chofer_id', chofer_id,
              'mes_tab', mes_tab,
              'mes_numero', mes_numero,
              'anio', anio,
              'tira_dias', tira_dias,
              'contabilizador', contabilizador
            )), '[]'::json)
           FROM public.diagramas
           WHERE anio = $1) AS preexistentes,
          (SELECT COALESCE(json_agg(json_build_object(
              'id', id,
              'nombre', UPPER(TRIM(nombre)),
              'legajo', legajo
            )), '[]'::json)
           FROM public.choferes WHERE nombre IS NOT NULL) AS choferes;
    `, [anio]);

    const dbPreexistentes = pgDataRes.rows[0]?.preexistentes || [];
    const dbChoferes = pgDataRes.rows[0]?.choferes || [];

    const diagDbMap = new Map();
    for (const d of dbPreexistentes) {
        if (d && d.chofer_id && (d.mes_tab === mesTab || d.mes_numero === mesNumero)) {
            diagDbMap.set(d.chofer_id, d);
        }
    }

    const choferesMap = new Map();
    for (const c of dbChoferes) {
        if (c.nombre) choferesMap.set('NOM:' + normText(c.nombre), c.id);
        if (c.legajo && c.legajo !== 'null') choferesMap.set('LEG:' + c.legajo, c.id);
    }

    // 2. Leer Google Sheet (A5:AN350 -> fila 5 cabeceras, fila 6+ choferes)
    const rawRows = await fetchRango(spreadsheetId, `'${mesTab}'!A5:AN350`);
    if (!rawRows || rawRows.length < 2) {
        console.warn(`⚠️ [Partición 5] Pestaña '${mesTab}' vacía o sin datos suficientes.`);
        return { success: true, message: "Sin datos en planilla", totalEvaluados: 0, modificados: 0 };
    }

    const headers = rawRows[0];
    const items = [];
    for (let i = 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        const obj = {};
        headers.forEach((h, hIdx) => {
            if (h) obj[h] = row[hIdx] !== undefined ? row[hIdx] : '';
            else obj[`col_${hIdx + 1}`] = row[hIdx] !== undefined ? row[hIdx] : '';
        });
        items.push(obj);
    }

    const deltaBatchMap = new Map();
    let nuevosCount = 0;
    let modificadosCount = 0;
    let omitidosCount = 0;
    let totalEvaluados = 0;
    const mesTabLower = mesTab.toLowerCase();

    for (const row of items) {
        const rawLegajo = String(row.col_1 ?? row.LEGAJO ?? row.legajo ?? row['0'] ?? '').trim();
        const rawNombre = String(row['APELLIDO Y NOMBRE'] ?? row.col_2 ?? row.nombre ?? row['1'] ?? row[mesTabLower] ?? '').trim().toUpperCase();
        const rawDiag = String(row.DIAGRAMA ?? row.col_4 ?? row.diagrama ?? row['3'] ?? '').trim().toUpperCase();

        const cleanNombre = rawNombre.replace(/\.+$/, '').trim();
        if (!cleanNombre || cleanNombre.length < 3 || /^\d+$/.test(cleanNombre) || blacklist.has(cleanNombre)) continue;
        if (/^[A-Z]{3}-\d{2}$/i.test(cleanNombre) || cleanNombre.startsWith('%')) continue;
        if (cleanNombre.startsWith('TOTAL') || cleanNombre.startsWith('PERSONAL ') || cleanNombre.startsWith('PASIVO ') ||
            ['FRANCO', 'FRANCOS', 'DIAS', 'NOMENCLATURAS'].includes(cleanNombre)) continue;

        // PRIORIDAD AL NOMBRE NORMALIZADO (Evita colisiones de legajo en la planilla)
        const choferId = choferesMap.get('NOM:' + normText(cleanNombre)) || 
                         (rawLegajo && rawLegajo !== '-' && rawLegajo !== 'null' ? choferesMap.get('LEG:' + rawLegajo) : null);
        if (!choferId) continue;

        totalEvaluados++;

        const dayEntries = [];
        for (const k of Object.keys(row)) {
            const trimmedKey = k.trim();
            const m = trimmedKey.match(/^(\d+)[\/\-](\d+)$/);
            if (m) {
                dayEntries.push({ key: k, dayNum: parseInt(m[1], 10) });
            } else {
                const mNum = trimmedKey.match(/^([1-9]|[12]\d|3[01])$/);
                if (mNum) dayEntries.push({ key: k, dayNum: parseInt(mNum[1], 10) });
            }
        }
        dayEntries.sort((a, b) => a.dayNum - b.dayNum);

        const diasMap = {};
        const tiraArr = [];

        for (const d of dayEntries) {
            const val = (row[d.key] !== undefined && row[d.key] !== null && String(row[d.key]).trim() !== '') ? String(row[d.key]).trim().toUpperCase() : '-';
            const cleanVal = val === '' ? '-' : val;
            const isoDate = `${anio}-${mesStr}-${String(d.dayNum).padStart(2, '0')}`;
            diasMap[isoDate] = cleanVal;
            tiraArr.push(cleanVal);
        }

        const tiraDias = tiraArr.join(',');
        const contabilizador = contabilizarDias(diasMap);

        const ex = diagDbMap.get(choferId);
        if (!ex) {
            nuevosCount++;
            deltaBatchMap.set(choferId, {
                chofer_id: choferId,
                diagrama_tipo: (rawDiag && rawDiag !== '-') ? rawDiag : null,
                mes_tab: mesTab,
                anio: anio,
                mes_numero: mesNumero,
                dias: diasMap,
                tira_dias: tiraDias,
                contabilizador: contabilizador
            });
        } else if (ex.tira_dias !== tiraDias) {
            modificadosCount++;
            deltaBatchMap.set(choferId, {
                chofer_id: choferId,
                diagrama_tipo: (rawDiag && rawDiag !== '-') ? rawDiag : null,
                mes_tab: mesTab,
                anio: anio,
                mes_numero: mesNumero,
                dias: diasMap,
                tira_dias: tiraDias,
                contabilizador: contabilizador
            });
        } else {
            omitidosCount++;
        }
    }

    const deltaBatch = Array.from(deltaBatchMap.values());

    if (deltaBatch.length > 0) {
        const batchJsonStr = JSON.stringify(deltaBatch).replace(/'/g, "''");
        const sqlQuery = `
          DO $$
          BEGIN
            INSERT INTO public.diagramas (
              chofer_id, diagrama_tipo, mes_tab, anio, mes_numero, dias, tira_dias, contabilizador, actualizado_el
            )
            SELECT DISTINCT ON ((x->>'chofer_id')::uuid)
              (x->>'chofer_id')::uuid,
              NULLIF(x->>'diagrama_tipo', ''),
              x->>'mes_tab',
              (x->>'anio')::int,
              (x->>'mes_numero')::int,
              (x->>'dias')::jsonb,
              x->>'tira_dias',
              (x->>'contabilizador')::jsonb,
              NOW()
            FROM jsonb_array_elements('${batchJsonStr}'::jsonb) AS x
            ON CONFLICT (chofer_id, anio, mes_numero)
            DO UPDATE SET
              diagrama_tipo = COALESCE(EXCLUDED.diagrama_tipo, public.diagramas.diagrama_tipo),
              mes_tab = EXCLUDED.mes_tab,
              dias = EXCLUDED.dias,
              tira_dias = EXCLUDED.tira_dias,
              contabilizador = EXCLUDED.contabilizador,
              actualizado_el = NOW();
          END $$;
        `;
        await db.query(sqlQuery);
        console.log(`✅ [Partición 5] Upsert completado en Supabase: ${deltaBatch.length} registros (${nuevosCount} nuevos, ${modificadosCount} modificados, ${omitidosCount} omitidos idénticos) en ${Date.now() - t0}ms.`);
    } else {
        console.log(`✅ [Partición 5] Sin cambios pendientes. Todos los ${omitidosCount} diagramas idénticos (Diffing O(1) Zero Egress).`);
    }

    return {
        success: true,
        mes_tab: mesTab,
        total_evaluados: totalEvaluados,
        nuevos: nuevosCount,
        modificados: modificadosCount,
        omitidos_identicos: omitidosCount,
        total_upsert: deltaBatch.length,
        duracion_ms: Date.now() - t0
    };
}

module.exports = function(cacheDatosGlobales, io, ioDash) {
    const router = express.Router();

    // POST /api/sync/diagramas o /api/sync/diagramas/sync
    router.post(['/', '/sync', '/sync-supabase'], async (req, res) => {
        try {
            const { mesTab, anio } = req.body || {};
            const resultado = await sincronizarDiagramasDesdeSheets(cacheDatosGlobales, io, ioDash, mesTab, anio);
            res.json(resultado);
        } catch (err) {
            console.error('❌ Error en sincronización de diagramas:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // GET /api/sync/diagramas/status
    router.get('/status', (req, res) => {
        res.json({
            servicio: 'Partición 5: Sincronizador de Días Diagrama (Google Sheets -> Supabase)',
            estado: 'activo',
            spreadsheetId: process.env.ID_SPREADSHEET_DIAGRAMAS || ID_SPREADSHEET_DIAGRAMAS || '14jgQZF0gkbT7k3mps1k3dM3qtoaseoCOUfK4PFRozKU'
        });
    });

    return router;
};

module.exports.sincronizarDiagramasDesdeSheets = sincronizarDiagramasDesdeSheets;
