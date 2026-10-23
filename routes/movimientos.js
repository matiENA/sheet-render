/**
 * routes/movimientos.js - Partición 6: Movimientos Activos y Desuniones
 * 
 * Extrae la matriz diaria de Movimientos desde Google Sheets (columna dinámica
 * según el día operativo en Argentina UTC-3), procesa desuniones explícitas
 * ('1', '', '-', '0', 'S/A', 'VACANTE') y pareos activos, y sincroniza
 * de forma atómica con Supabase (public.movimientos, choferes y unidades).
 * Luego actualiza la Hot RAM en memoria y emite a Socket.IO (/ y /dash).
 */

const express = require('express');
const db = require('../utils/db');
const { supabase } = require('../utils/shared');
const {
    fetchRango,
    getTabName,
    ID_SHEET_MOVIMIENTOS,
    getFechaArgentina,
    mesesLargo
} = require('../utils/shared');

const blacklist = new Set([
    'TRACTOR', 'SEMI', 'CHOFER', 'NOMBRE', 'APELLIDO', '1', '0', '-', 'S/A', 'VACANTE',
    'FECHA', 'N°', 'CISTERNADO', 'TOTAL', 'LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'OCTUBRE',
    'DESCANSO', 'FRANCO', 'VACACIONES', 'LICENCIA', 'GUARDIA', 'EN GESTION', 'DISPONIBLE'
]);

let cacheRecorte = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 15000;

async function extraerPareosYDesunionesDesdeSheets(diaParam = null) {
    const now = Date.now();
    if (!diaParam && cacheRecorte && (now - cacheTimestamp < CACHE_TTL_MS)) {
        return cacheRecorte;
    }

    const tab = await getTabName(ID_SHEET_MOVIMIENTOS, 'Mov.Unidades', 'OCTUBRE 2026- Mov.Unidades y Choferes');
    const rows = await fetchRango(ID_SHEET_MOVIMIENTOS, `'${tab}'!A1:ZZ350`);

    const hoyAr = getFechaArgentina();
    const diaHoy = diaParam ? parseInt(diaParam, 10) : hoyAr.getDate();
    // Stride canónico: Día 1 = Col 27, Día 2 = Col 40 ... Día d = 27 + 13 * (d - 1)
    const colChoferHoy = 27 + 13 * (diaHoy - 1);

    const pareos = [];
    const desuniones = [];
    let currentSrv = 'GENERAL';

    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length === 0) continue;

        const col0 = String(r[0] || '').trim();
        const col2 = String(r[2] || '').trim();
        const col4 = String(r[4] || '').trim();
        const col5 = String(r[5] || '').trim();

        // Detección de fila cabecera de Categoría / Servicio
        if (col0 && !col2 && !col4 && !col5) {
            const up = col0.toUpperCase();
            if (!up.includes('FECHA') && !up.includes('N°') && !mesesLargo.some(m => up.includes(m.toUpperCase()))) {
                currentSrv = up;
            }
            continue;
        }

        const tractor = col4.toUpperCase().replace(/\s+/g, '');
        const semi = col5.toUpperCase().replace(/\s+/g, '');
        const nUte = col2.replace(/[^0-9]/g, '');

        if (!tractor && !semi && !nUte) continue;
        if (tractor === 'TRACTOR' || semi === 'SEMI') continue;

        const rawChofer = colChoferHoy < r.length ? String(r[colChoferHoy] || '').trim() : '';

        // Regla Canónica: Desunión ('1', '', '-', '0', 'S/A', 'VACANTE', etc.)
        const esDesunion = (!rawChofer || rawChofer === '1' || rawChofer === '0' || rawChofer === '-' ||
                            rawChofer.length < 3 || !/[a-zA-Z]/.test(rawChofer) || blacklist.has(rawChofer.toUpperCase()));

        if (esDesunion) {
            desuniones.push({
                n_ute: nUte || null,
                patente_tractor: tractor || '',
                patente_semi: semi || '',
                raw_chofer: rawChofer,
                accion: 'DESUNIR',
                dia_operativo: diaHoy
            });
        } else {
            pareos.push({
                n_ute: nUte || null,
                patente_tractor: tractor || '',
                patente_semi: semi || '',
                chofer_nombre: rawChofer.replace(/,/g, '').toUpperCase(),
                servicio_denominacion: currentSrv,
                accion: 'UPSERT',
                dia_operativo: diaHoy
            });
        }
    }

    const resultado = { pareos, desuniones, diaHoy };

    if (!diaParam) {
        cacheRecorte = resultado;
        cacheTimestamp = Date.now();
    }

    return resultado;
}

/**
 * Función central de sincronización hacia Supabase y Hot RAM
 */
async function sincronizarMovimientosDesdeSheets(cacheDatosGlobales = null, io = null, ioDash = null, diaParam = null) {
    const t0 = Date.now();
    console.log("🔄 [Partición 6] Extrayendo pareos y desuniones desde Google Sheets...");

    const { pareos, desuniones, diaHoy } = await extraerPareosYDesunionesDesdeSheets(diaParam);
    console.log(`📊 [Partición 6] Extraídos: ${pareos.length} pareos activos, ${desuniones.length} desuniones (Día ${diaHoy}).`);

    let desunidosDeleted = 0;
    let insertados = 0;

    if (db.isConfigured()) {
        // PASO 1: Resolver unidades a desunir (chofer = 1 o borrado)
        const desunionesRes = await db.query(`
            WITH desuniones_input AS (
              SELECT * FROM jsonb_to_recordset($1::jsonb) AS d(
                n_ute text,
                patente_tractor text,
                patente_semi text
              )
            )
            SELECT DISTINCT u.id AS id_unidad
            FROM desuniones_input d
            LEFT JOIN public.tractores t ON UPPER(TRIM(t.patente)) = UPPER(TRIM(d.patente_tractor)) AND TRIM(d.patente_tractor) <> ''
            LEFT JOIN public.semis s ON UPPER(TRIM(s.patente)) = UPPER(TRIM(d.patente_semi)) AND TRIM(d.patente_semi) <> ''
            JOIN public.unidades u ON (
              (t.id IS NOT NULL AND u.tractor_id = t.id)
              OR (s.id IS NOT NULL AND u.semi_id = s.id)
              OR (NULLIF(TRIM(d.n_ute), '') IS NOT NULL AND u.n_ute = TRIM(d.n_ute))
            )
        `, [JSON.stringify(desuniones)]);

        const desunirIds = desunionesRes.rows.map(r => r.id_unidad);

        // PASO 2: Resolver pareos activos válidos
        const pareosRes = await db.query(`
            WITH pareos_input AS (
              SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
                n_ute text,
                patente_tractor text,
                patente_semi text,
                chofer_nombre text,
                servicio_denominacion text,
                dia_operativo int
              )
            ),
            resolved_raw AS (
              SELECT
                u.id AS id_unidad,
                c.id AS id_chofer,
                ROW_NUMBER() OVER (
                  PARTITION BY u.id 
                  ORDER BY (t.id IS NOT NULL AND u.tractor_id = t.id) DESC, 
                           (s.id IS NOT NULL AND u.semi_id = s.id) DESC
                ) as rn_u
              FROM pareos_input p
              JOIN public.choferes c ON UPPER(TRIM(REPLACE(c.nombre, ',', ''))) = UPPER(TRIM(REPLACE(p.chofer_nombre, ',', '')))
              LEFT JOIN public.tractores t ON UPPER(TRIM(t.patente)) = UPPER(TRIM(p.patente_tractor)) AND TRIM(p.patente_tractor) <> ''
              LEFT JOIN public.semis s ON UPPER(TRIM(s.patente)) = UPPER(TRIM(p.patente_semi)) AND TRIM(p.patente_semi) <> ''
              JOIN public.unidades u ON (
                (t.id IS NOT NULL AND u.tractor_id = t.id)
                OR (s.id IS NOT NULL AND u.semi_id = s.id)
                OR (NULLIF(TRIM(p.n_ute), '') IS NOT NULL AND u.n_ute = TRIM(p.n_ute))
              )
              WHERE u.id IS NOT NULL AND c.id IS NOT NULL
            ),
            resolved_units AS (
              SELECT id_unidad, id_chofer 
              FROM resolved_raw 
              WHERE rn_u = 1
            )
            SELECT DISTINCT ON (id_chofer) id_unidad, id_chofer
            FROM resolved_units
            ORDER BY id_chofer
        `, [JSON.stringify(pareos)]);

        const validPareos = pareosRes.rows;
        const activeUnitIds = validPareos.map(p => p.id_unidad);
        const activeChoferIds = validPareos.map(p => p.id_chofer);

        // PASO 3: Ejecutar desuniones (eliminar de movimientos y liberar choferes)
        if (desunirIds.length > 0) {
            const delDes = await db.query(`DELETE FROM public.movimientos WHERE id_unidad = ANY($1::uuid[]) RETURNING id`, [desunirIds]);
            desunidosDeleted = delDes.rowCount || 0;

            await db.query(`
                UPDATE public.choferes
                SET unidad_id = NULL,
                    estado = CASE WHEN estado = 'circulando' THEN 'inactivo' ELSE estado END,
                    actualizado_el = NOW()
                WHERE unidad_id = ANY($1::uuid[])
            `, [desunirIds]);

            await db.query(`
                UPDATE public.unidades
                SET estado = 'disponible'
                WHERE id = ANY($1::uuid[])
            `, [desunirIds]);
        }

        // PASO 4: Limpiar asignaciones previas de choferes o unidades activas
        if (activeUnitIds.length > 0) {
            await db.query(`DELETE FROM public.movimientos WHERE id_unidad = ANY($1::uuid[]) OR id_chofer = ANY($2::uuid[])`, [activeUnitIds, activeChoferIds]);
        }

        // PASO 5: Insertar pareos activos
        if (validPareos.length > 0) {
            const insRes = await db.query(`
                INSERT INTO public.movimientos (id_unidad, id_chofer, actualizado_el)
                SELECT id_unidad, id_chofer, NOW()
                FROM jsonb_to_recordset($1::jsonb) AS x(id_unidad uuid, id_chofer uuid)
                ON CONFLICT (id_unidad) DO UPDATE SET
                  id_chofer = EXCLUDED.id_chofer,
                  actualizado_el = NOW()
                RETURNING id
            `, [JSON.stringify(validPareos)]);
            insertados = insRes.rowCount || 0;

            await db.query(`
                UPDATE public.choferes
                SET unidad_id = m.id_unidad,
                    estado = 'circulando',
                    actualizado_el = NOW()
                FROM jsonb_to_recordset($1::jsonb) AS m(id_unidad uuid, id_chofer uuid)
                WHERE choferes.id = m.id_chofer
            `, [JSON.stringify(validPareos)]);

            await db.query(`
                UPDATE public.unidades
                SET estado = 'circulando'
                WHERE id = ANY($1::uuid[])
            `, [activeUnitIds]);
        }
    } else if (supabase) {
        // Fallback vía cliente PostgREST
        console.warn("⚠️ [Partición 6] PostgreSQL directo no configurado, sincronizando vía cliente Supabase...");
        // 1. Obtener catálogo para resolución
        const [{ data: chList }, { data: uList }] = await Promise.all([
            supabase.from('choferes').select('id, nombre'),
            supabase.from('unidades').select('id, n_ute, tractor_id, semi_id')
        ]);

        const uByNute = {};
        (uList || []).forEach(u => { if (u.n_ute) uByNute[String(u.n_ute).trim()] = u.id; });

        const chByName = {};
        (chList || []).forEach(c => {
            const norm = c.nombre ? c.nombre.trim().toUpperCase().replace(/,/g, '') : '';
            if (norm) chByName[norm] = c.id;
        });

        // Desuniones por N° UTE
        const desunirUteIds = desuniones.map(d => d.n_ute && uByNute[d.n_ute]).filter(Boolean);
        if (desunirUteIds.length > 0) {
            await supabase.from('movimientos').delete().in('id_unidad', desunirUteIds);
            await supabase.from('choferes').update({ unidad_id: null, estado: 'inactivo' }).in('unidad_id', desunirUteIds);
            desunidosDeleted = desunirUteIds.length;
        }

        // Pareos
        const pareosInsert = [];
        pareos.forEach(p => {
            const uId = p.n_ute ? uByNute[p.n_ute] : null;
            const cId = p.chofer_nombre ? chByName[p.chofer_nombre] : null;
            if (uId && cId) {
                pareosInsert.push({ id_unidad: uId, id_chofer: cId });
            }
        });

        if (pareosInsert.length > 0) {
            const uIds = pareosInsert.map(x => x.id_unidad);
            const cIds = pareosInsert.map(x => x.id_chofer);
            await supabase.from('movimientos').delete().or(`id_unidad.in.(${uIds.join(',')}),id_chofer.in.(${cIds.join(',')})`);
            const { data: insData } = await supabase.from('movimientos').upsert(pareosInsert, { onConflict: 'id_unidad' });
            insertados = pareosInsert.length;

            for (const item of pareosInsert) {
                await supabase.from('choferes').update({ unidad_id: item.id_unidad, estado: 'circulando' }).eq('id', item.id_chofer);
                await supabase.from('unidades').update({ estado: 'circulando' }).eq('id', item.id_unidad);
            }
        }
    }

    console.log(`✅ [Partición 6] Supabase actualizado en ${Date.now() - t0} ms (${insertados} pareos insertados/actualizados, ${desunidosDeleted} desuniones aplicadas).`);

    // PASO 6: Reensamblado instantáneo de la Hot RAM en memoria y broadcast WebSocket
    if (cacheDatosGlobales) {
        try {
            const { flujoEncoladoGlobal } = require('../cache/builder');
            await flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash, { forceFull: true, recargarKm: false });
            console.log("⚡ [Partición 6] Hot RAM reensamblada y broadcast emitido tras sincronización.");
        } catch (eRam) {
            console.error("⚠️ [Partición 6] Error refrescando RAM:", eRam.message);
        }
    }

    return {
        success: true,
        dia_operativo: diaHoy,
        total_pareos_activos: pareos.length,
        total_desuniones_detectadas: desuniones.length,
        desuniones_aplicadas: desunidosDeleted,
        insertados: insertados,
        latenciaMs: Date.now() - t0,
        timestamp: new Date().toISOString()
    };
}

module.exports = function createMovimientosRouter(cacheDatosGlobales, io, ioDash) {
    const router = express.Router();

    // 1. GET /api/movimientos/recorte-diario — Vista previa del recorte de Google Sheets
    router.get('/recorte-diario', async (req, res) => {
        const t0 = Date.now();
        try {
            const { dia } = req.query;
            const { pareos, desuniones, diaHoy } = await extraerPareosYDesunionesDesdeSheets(dia);

            res.json({
                success: true,
                dia_operativo: diaHoy,
                total_pareos: pareos.length,
                total_desuniones: desuniones.length,
                latenciaMs: Date.now() - t0,
                datos: pareos,
                desuniones: desuniones
            });
        } catch (err) {
            console.error('❌ Error en GET /api/movimientos/recorte-diario:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 2. POST /api/movimientos/sync-supabase — Sincronización activa (Google Sheets -> Supabase -> Hot RAM)
    router.post(['/sync-supabase', '/sync'], async (req, res) => {
        try {
            const { dia } = req.body || {};
            const resultado = await sincronizarMovimientosDesdeSheets(cacheDatosGlobales, io, ioDash, dia);
            res.json(resultado);
        } catch (err) {
            console.error('❌ Error en POST /api/movimientos/sync-supabase:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};

module.exports.sincronizarMovimientosDesdeSheets = sincronizarMovimientosDesdeSheets;
module.exports.extraerPareosYDesunionesDesdeSheets = extraerPareosYDesunionesDesdeSheets;
