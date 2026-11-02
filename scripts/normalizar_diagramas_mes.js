#!/usr/bin/env node
/**
 * scripts/normalizar_diagramas_mes.js
 * 
 * Normalizador de Cambio de Mes para Diagramas (Google Sheets -> Supabase)
 * Planilla: 14jgQZF0gkbT7k3mps1k3dM3qtoaseoCOUfK4PFRozKU (DIAGRAMAS EOR REV02 2026)
 * Tabla destino: public.diagramas
 * 
 * Uso:
 *   node scripts/normalizar_diagramas_mes.js [--meses=Oct-26,Nov-26] [--overwrite] [--dry-run]
 * 
 * Argumentos:
 *   --meses=Tab1,Tab2   Pestañas a normalizar (defecto: mes anterior + mes actual)
 *   --mes=Tab           Pestaña única
 *   --overwrite, --force Forzar actualización atómica en Supabase omitiendo el filtro de igualdad
 *   --dry-run           Simular normalización sin escribir en la base de datos
 */

const path = require('path');
const { Pool } = require('pg');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// Cargar variables de entorno
require('dotenv').config({ path: path.join(__dirname, '../.env') });
if (!process.env.DATABASE_URL) {
    require('dotenv').config({ path: path.join(__dirname, '../extractor_local/.env') });
}

let ID_SPREADSHEET_DIAGRAMAS = process.env.ID_SPREADSHEET_DIAGRAMAS || '14jgQZF0gkbT7k3mps1k3dM3qtoaseoCOUfK4PFRozKU';
const mesesAbrev = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// Parsing CLI args
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isOverwrite = args.includes('--overwrite') || args.includes('--force');

let targetTabs = [];
for (const arg of args) {
    if (arg.startsWith('--meses=')) {
        targetTabs = arg.replace('--meses=', '').split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--mes=')) {
        targetTabs = [arg.replace('--mes=', '').trim()];
    } else if (arg.startsWith('--id=')) {
        ID_SPREADSHEET_DIAGRAMAS = arg.replace('--id=', '').trim();
    }
}

function getFechaArgentina() {
    const now = new Date();
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utcTime - (3 * 3600000));
}

// Si no se pasaron pestañas, normalizar por defecto: mes anterior y mes actual
if (targetTabs.length === 0) {
    const hoyAr = getFechaArgentina();
    const anioActual = hoyAr.getFullYear();
    const mesActualIdx = hoyAr.getMonth(); // 0-11
    const yy = String(anioActual).slice(-2);

    const prevDate = new Date(anioActual, mesActualIdx - 1, 1);
    const yyPrev = String(prevDate.getFullYear()).slice(-2);

    const tabAnterior = `${mesesAbrev[prevDate.getMonth()]}-${yyPrev}`;
    const tabActual = `${mesesAbrev[mesActualIdx]}-${yy}`;
    targetTabs = [tabAnterior, tabActual];
}

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

async function getDoc() {
    let creds = null;
    const credPaths = [
        path.join(__dirname, '../extractor_local/service_account.json'),
        path.join(__dirname, '../service_account.json'),
        'C:/Users/Matias Rodriguez/Documents/credenciales/service_account.json',
        'C:/Users/Matias Rodriguez/Documents/server_local/extractor_local/service_account.json'
    ];
    for (const p of credPaths) {
        try {
            creds = require(p);
            break;
        } catch (e) {}
    }
    if (!creds && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        creds = {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
        };
    }
    if (!creds) {
        throw new Error('No se encontraron credenciales de Google Service Account');
    }

    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const doc = new GoogleSpreadsheet(ID_SPREADSHEET_DIAGRAMAS, serviceAccountAuth);
    await doc.loadInfo();
    return doc;
}

async function normalizarMes(pool, doc, mesTab) {
    const t0 = Date.now();
    console.log(`\n===============================================================`);
    console.log(`🗓️  NORMALIZANDO PESTAÑA: [${mesTab}]`);
    console.log(`===============================================================`);

    // Deducir mes y año desde el nombre de pestaña
    const parts = mesTab.split('-');
    const mIdx = mesesAbrev.findIndex(m => m.toLowerCase() === parts[0].toLowerCase());
    if (mIdx === -1) {
        console.warn(`⚠️ Nombre de pestaña no reconocido: ${mesTab}`);
        return { success: false, error: 'Pestaña no reconocida' };
    }
    const mesNumero = mIdx + 1;
    const anio = parts[1] ? parseInt('20' + parts[1].replace(/\D/g, ''), 10) : 2026;
    const mesStr = String(mesNumero).padStart(2, '0');
    const maxDays = new Date(anio, mesNumero, 0).getDate();

    console.log(`   • Parámetros: Mes ${mesNumero} (${mesesAbrev[mIdx]}), Año ${anio}, Días Calendario: ${maxDays}`);

    // 1. Obtener catálogo de choferes y registros preexistentes de public.diagramas
    const pgDataRes = await pool.query(`
        SELECT 
          (SELECT COALESCE(json_agg(json_build_object(
              'chofer_id', chofer_id,
              'mes_tab', mes_tab,
              'mes_numero', mes_numero,
              'anio', anio,
              'tira_dias', tira_dias,
              'contabilizador', contabilizador,
              'dias', dias
            )), '[]'::json)
           FROM public.diagramas
           WHERE anio = $1 AND mes_numero = $2) AS preexistentes,
          (SELECT COALESCE(json_agg(json_build_object(
              'id', id,
              'nombre', UPPER(TRIM(nombre)),
              'legajo', legajo
            )), '[]'::json)
           FROM public.choferes WHERE nombre IS NOT NULL) AS choferes;
    `, [anio, mesNumero]);

    const dbPreexistentes = pgDataRes.rows[0]?.preexistentes || [];
    const dbChoferes = pgDataRes.rows[0]?.choferes || [];

    const diagDbMap = new Map();
    for (const d of dbPreexistentes) {
        if (d && d.chofer_id) {
            diagDbMap.set(d.chofer_id, d);
        }
    }

    const choferesMap = new Map();
    for (const c of dbChoferes) {
        if (c.nombre) choferesMap.set('NOM:' + normText(c.nombre), c.id);
        if (c.legajo && c.legajo !== 'null') choferesMap.set('LEG:' + c.legajo, c.id);
    }
    console.log(`   • Supabase: ${dbChoferes.length} choferes indexados, ${diagDbMap.size} diagramas preexistentes en mes ${mesNumero}.`);

    // 2. Leer hoja de Google Sheets
    const sheet = doc.sheetsByTitle[mesTab];
    if (!sheet) {
        console.warn(`⚠️ Pestaña '${mesTab}' no existe en el spreadsheet ${ID_SPREADSHEET_DIAGRAMAS}`);
        return { success: false, error: 'Pestaña inexistente' };
    }

    // Cargar rango A5:AN350
    const rawRows = await sheet.getCellsInRange('A5:AN350');
    if (!rawRows || rawRows.length < 2) {
        console.warn(`⚠️ Pestaña '${mesTab}' sin datos suficientes.`);
        return { success: false, error: 'Sin datos' };
    }

    const headers = rawRows[0];
    const items = [];
    for (let i = 1; i < rawRows.length; i++) {
        const row = rawRows[i];
        const obj = {};
        headers.forEach((h, hIdx) => {
            const hClean = h ? String(h).trim() : '';
            if (hClean) obj[hClean] = row[hIdx] !== undefined ? row[hIdx] : '';
            else obj[`col_${hIdx + 1}`] = row[hIdx] !== undefined ? row[hIdx] : '';
        });
        items.push(obj);
    }

    // 3. Normalizar matriz diaria
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

        // PRIORIDAD AL NOMBRE NORMALIZADO
        const choferId = choferesMap.get('NOM:' + normText(cleanNombre)) || 
                         (rawLegajo && rawLegajo !== '-' && rawLegajo !== 'null' ? choferesMap.get('LEG:' + rawLegajo) : null);
        if (!choferId) continue;

        totalEvaluados++;

        // Extracción estricta de días: SOLAMENTE días válidos del mes actual (1..maxDays)
        const dayEntries = [];
        const dayFound = new Set();

        for (const k of Object.keys(row)) {
            const trimmedKey = k.trim();
            const m = trimmedKey.match(/^(\d+)[\/\-](\d+)$/);
            if (m) {
                const dNum = parseInt(m[1], 10);
                const moNum = parseInt(m[2], 10);
                // Validación estricta: El mes de la cabecera DEBE coincidir con mesNumero
                if (moNum === mesNumero && dNum >= 1 && dNum <= maxDays && !dayFound.has(dNum)) {
                    dayEntries.push({ key: k, dayNum: dNum });
                    dayFound.add(dNum);
                }
            } else {
                const mNumCol = trimmedKey.match(/^([1-9]|[12]\d|3[01])$/);
                if (mNumCol) {
                    const dNum = parseInt(mNumCol[1], 10);
                    if (dNum >= 1 && dNum <= maxDays && !dayFound.has(dNum)) {
                        dayEntries.push({ key: k, dayNum: dNum });
                        dayFound.add(dNum);
                    }
                }
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
                chofer_nombre: cleanNombre,
                diagrama_tipo: (rawDiag && rawDiag !== '-') ? rawDiag : null,
                mes_tab: mesTab,
                anio: anio,
                mes_numero: mesNumero,
                dias: diasMap,
                tira_dias: tiraDias,
                contabilizador: contabilizador,
                motivo: 'NUEVO'
            });
        } else if (isOverwrite || ex.tira_dias !== tiraDias) {
            modificadosCount++;
            deltaBatchMap.set(choferId, {
                chofer_id: choferId,
                chofer_nombre: cleanNombre,
                diagrama_tipo: (rawDiag && rawDiag !== '-') ? rawDiag : null,
                mes_tab: mesTab,
                anio: anio,
                mes_numero: mesNumero,
                dias: diasMap,
                tira_dias: tiraDias,
                contabilizador: contabilizador,
                motivo: isOverwrite ? 'OVERWRITE_FORZADO' : 'CAMBIO_DETECTADO'
            });
        } else {
            omitidosCount++;
        }
    }

    const deltaBatch = Array.from(deltaBatchMap.values());
    console.log(`   • Análisis completado:`);
    console.log(`     - Total choferes evaluados: ${totalEvaluados}`);
    console.log(`     - Nuevos: ${nuevosCount}`);
    console.log(`     - Modificados / A actualizar: ${modificadosCount}`);
    console.log(`     - Omitidos idénticos: ${omitidosCount}`);

    // Muestra de cambios detectados
    if (deltaBatch.length > 0) {
        console.log(`\n   🔍 Muestra de 3 choferes a actualizar:`);
        deltaBatch.slice(0, 3).forEach(d => {
            const ex = diagDbMap.get(d.chofer_id);
            console.log(`     • [${d.chofer_nombre}]: Motivo: ${d.motivo}`);
            if (ex) {
                console.log(`       BD anterior (tira len ${ex.tira_dias?.split(',').length}): ${ex.tira_dias?.slice(0, 25)}...`);
            }
            console.log(`       Nuevo normalizado (tira len ${d.tira_dias.split(',').length}): ${d.tira_dias.slice(0, 25)}...`);
        });
    }

    // 4. Escribir en Supabase si no es dry-run
    if (deltaBatch.length > 0 && !isDryRun) {
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
        await pool.query(sqlQuery);
        console.log(`   ✅ [Supabase] Upsert atómico completado con éxito: ${deltaBatch.length} registros guardados en ${Date.now() - t0}ms.`);
    } else if (isDryRun) {
        console.log(`   🛡️ [DRY-RUN] Simulación activa. No se aplicaron escrituras en Supabase.`);
    } else {
        console.log(`   ✅ [Partición 5] Sin cambios pendientes. Todos los registros idénticos.`);
    }

    return {
        mesTab,
        mesNumero,
        anio,
        totalEvaluados,
        nuevosCount,
        modificadosCount,
        omitidosCount,
        totalEscritos: deltaBatch.length,
        duracionMs: Date.now() - t0
    };
}

async function main() {
    const tGlobal = Date.now();
    console.log(`========================================================================`);
    console.log(`🚀 INICIANDO NORMALIZADOR DE TRANSICIÓN MENSUAL (DIAGRAMAS EOR)`);
    console.log(`   Modo: ${isDryRun ? 'DRY-RUN (Simulación)' : (isOverwrite ? 'OVERWRITE FORZADO' : 'DIFFING ESTÁNDAR')}`);
    console.log(`   Pestañas objetivo: ${targetTabs.join(', ')}`);
    console.log(`   Base de datos: Supabase (public.diagramas)`);
    console.log(`========================================================================`);

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const doc = await getDoc();

    const report = [];
    for (const tab of targetTabs) {
        try {
            const res = await normalizarMes(pool, doc, tab);
            report.push(res);
        } catch (err) {
            console.error(`❌ Error procesando pestaña ${tab}:`, err);
            report.push({ mesTab: tab, error: err.message });
        }
    }

    await pool.end();

    console.log(`\n========================================================================`);
    console.log(`📊 RESUMEN FINAL DE NORMALIZACIÓN (Duración total: ${Date.now() - tGlobal}ms)`);
    console.log(`========================================================================`);
    console.table(report.map(r => ({
        Tab: r.mesTab,
        Mes: r.mesNumero,
        Evaluados: r.totalEvaluados || 0,
        Nuevos: r.nuevosCount || 0,
        Modificados: r.modificadosCount || 0,
        Omitidos: r.omitidosCount || 0,
        Escritos: r.totalEscritos || 0,
        Ms: r.duracionMs || '-'
    })));
    console.log(`✨ Proceso finalizado.`);
}

main().catch(err => {
    console.error(`💥 Error fatal:`, err);
    process.exit(1);
});
