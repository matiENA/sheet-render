const express = require('express');
const db = require('../utils/db');
const { supabase, normalizar } = require('../utils/shared');

/**
 * Motor Contabilizador Canónico de Días
 */
function getBaseState(val) {
    if (val === undefined || val === null) return '';
    const str = String(val).trim().toUpperCase();
    if (str.includes('+')) return str.split('+')[0].trim();
    return str;
}

function contabilizarDias(diasMap) {
    let trabajados = 0;
    let francos = 0;
    let vacaciones = 0;
    let ausencias = 0;
    let inactivos = 0;
    const desglose = {
        enfermedad: 0,
        art: 0,
        indisposicion: 0,
        suspension: 0,
        ausencia: 0,
        permiso: 0,
        otros: 0
    };

    const entries = Object.entries(diasMap || {});
    for (const [, val] of entries) {
        if (!val || val === '-' || val === '0' || val === 'NULL' || val === 'UNDEFINED') {
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

    return {
        total_evaluados: entries.length,
        trabajados,
        francos,
        vacaciones,
        ausencias,
        inactivos,
        desglose
    };
}

module.exports = function createDiagramasRouter() {
    const router = express.Router();

    // 1. GET /api/diagramas/parametros — Diccionario de parámetros
    router.get('/parametros', (req, res) => {
        res.json({
            servicio: "Consultas de Diagramas Bajo Demanda (Supabase)",
            descripcion: "Permite consultar cualquier rango de fechas histórico o futuro, evaluar el contabilizador canónico y filtrar por chofer, servicio o tipo de diagrama.",
            endpoints: [
                {
                    ruta: "GET /api/diagramas/consulta",
                    descripcion: "Consulta bajo demanda por rango de fechas arbitrario con cálculo dinámico del contabilizador.",
                    parametros: {
                        desde: { tipo: "String (YYYY-MM-DD)", requerido: true, descripcion: "Fecha inicial del rango.", ejemplo: "2026-08-01" },
                        hasta: { tipo: "String (YYYY-MM-DD)", requerido: true, descripcion: "Fecha final del rango (>= desde).", ejemplo: "2026-08-31" },
                        chofer: { tipo: "String", requerido: false, descripcion: "Filtro por nombre parcial o completo del chofer.", ejemplo: "ACUÑA" },
                        legajo: { tipo: "String", requerido: false, descripcion: "Filtro exacto por número de legajo.", ejemplo: "744" },
                        servicio: { tipo: "String", requerido: false, descripcion: "Filtro por servicio de flota.", opciones: ["METANOL", "LIVIANO", "CAMPO", "GLP"] },
                        diagrama_tipo: { tipo: "String", requerido: false, descripcion: "Filtro por esquema de rotación.", opciones: ["22X6", "14X7"] },
                        formato: { tipo: "String", requerido: false, default: "completo", opciones: ["completo", "resumido"] },
                        limit: { tipo: "Integer", requerido: false, descripcion: "Límite de resultados retornados para paginación." },
                        offset: { tipo: "Integer", requerido: false, default: 0, descripcion: "Salto de registros para paginación." }
                    }
                },
                {
                    ruta: "GET /api/diagramas/mes/:mesTab",
                    descripcion: "Obtiene los registros mensuales completos persistidos en la tabla Supabase 'diagramas'.",
                    parametros: {
                        mesTab: { tipo: "Path String", requerido: true, descripcion: "Pestaña mensual.", ejemplo: "Sep-26" },
                        servicio: { tipo: "Query String", requerido: false, descripcion: "Filtro por servicio." },
                        limit: { tipo: "Query Integer", requerido: false, default: 500, descripcion: "Límite de registros." }
                    }
                },
                {
                    ruta: "GET /api/diagramas/chofer/:idOrNombre",
                    descripcion: "Consulta el historial completo y JSON de un chofer específico por ID, Legajo o Nombre.",
                    parametros: {
                        idOrNombre: { tipo: "Path String", requerido: true, descripcion: "ID UUID, número de legajo o Nombre.", ejemplo: "ACUÑA RAFAEL SANTIAGO" }
                    }
                }
            ],
            contabilizador_reglas: {
                trabajados: "Números (1-35), 'O', 'OPERATIVO'",
                francos: "'F', 'FSF', 'FRANCO', 'RPT', 'F+...'",
                vacaciones: "'V', 'VSF', 'VACACIONES', 'V+...'",
                ausencias: "'E'/'MED' (enfermedad), 'ART', 'IND' (indisposición), 'S' (suspensión), 'A' (ausente), 'P' (permiso), 'LIC'",
                inactivos: "'-', '0', vacío",
                regla_modificador_plus: "Cualquier código con '+' (ej: F+1, E+23, O+30) se preserva textual en caracteres y cuenta estrictamente como 1 día en su categoría base."
            }
        });
    });

    // 2. GET /api/diagramas/consulta — Consulta dinámica por rango
    router.get('/consulta', async (req, res) => {
        try {
            const { desde, hasta, chofer, nombre, legajo, servicio, diagrama_tipo, tipo, formato, limit, limite, offset } = req.query;
            const choferFiltro = chofer || nombre;
            const diagramaFiltro = diagrama_tipo || tipo;
            const formatoVal = (formato || 'completo').toLowerCase();
            const limitParam = parseInt(limit || limite, 10);
            const offsetParam = parseInt(offset || '0', 10);

            if (!desde || !hasta) {
                return res.status(400).json({
                    error: "Debe proveer los parámetros de fecha obligatorios 'desde' y 'hasta' (formato YYYY-MM-DD).",
                    ejemplo: "/api/diagramas/consulta?desde=2026-08-01&hasta=2026-08-31&servicio=METANOL",
                    parametros_disponibles: ["desde", "hasta", "chofer", "legajo", "servicio", "diagrama_tipo", "formato", "limit", "offset"]
                });
            }

            const dCurrent = new Date(desde + 'T12:00:00');
            const dEnd = new Date(hasta + 'T12:00:00');
            if (isNaN(dCurrent.getTime()) || isNaN(dEnd.getTime()) || dCurrent > dEnd) {
                return res.status(400).json({ error: "Rango de fechas inválido. Formato requerido: YYYY-MM-DD y 'desde' <= 'hasta'." });
            }

            const diasRango = [];
            for (let d = new Date(dCurrent); d <= dEnd; d.setDate(d.getDate() + 1)) {
                diasRango.push(d.toISOString().split('T')[0]);
            }

            const t0 = Date.now();
            let rowsChoferes = [];

            if (db.isConfigured()) {
                const resC = await db.query(`
                    SELECT id, nombre, legajo, c_servicio, diagrama_tipo, diagrama_json 
                    FROM choferes 
                    WHERE diagrama_json IS NOT NULL
                    ORDER BY nombre ASC
                `);
                rowsChoferes = resC.rows || [];
            } else {
                const { data, error } = await supabase.from('choferes').select('id, nombre, legajo, c_servicio, diagrama_tipo, diagrama_json').not('diagrama_json', 'is', null).order('nombre');
                if (error) throw error;
                rowsChoferes = data || [];
            }

            // Aplicar filtros
            let targetChoferes = rowsChoferes;
            if (choferFiltro) {
                const normFiltro = normalizar(choferFiltro);
                targetChoferes = targetChoferes.filter(c => normalizar(c.nombre).includes(normFiltro) || String(c.legajo) === choferFiltro);
            }
            if (legajo) {
                targetChoferes = targetChoferes.filter(c => String(c.legajo).trim() === String(legajo).trim());
            }
            if (servicio) {
                const srvUpper = servicio.trim().toUpperCase();
                targetChoferes = targetChoferes.filter(c => (c.c_servicio || '').toUpperCase() === srvUpper);
            }
            if (diagramaFiltro) {
                const diagUpper = diagramaFiltro.trim().toUpperCase();
                targetChoferes = targetChoferes.filter(c => (c.diagrama_tipo || '').toUpperCase() === diagUpper);
            }

            const totalCoincidencias = targetChoferes.length;

            let choferesPaginados = targetChoferes;
            if (!isNaN(offsetParam) && offsetParam > 0) choferesPaginados = choferesPaginados.slice(offsetParam);
            if (!isNaN(limitParam) && limitParam > 0) choferesPaginados = choferesPaginados.slice(0, limitParam);

            const resultados = [];
            for (const c of choferesPaginados) {
                const diagJson = c.diagrama_json;
                const caracteresRango = {};

                diasRango.forEach(iso => {
                    let car = '-';
                    if (diagJson && diagJson.caracteres_60_dias && diagJson.caracteres_60_dias[iso]) {
                        car = diagJson.caracteres_60_dias[iso];
                    } else if (diagJson && diagJson.meses) {
                        for (const mesKey in diagJson.meses) {
                            if (diagJson.meses[mesKey].dias && diagJson.meses[mesKey].dias[iso]) {
                                car = diagJson.meses[mesKey].dias[iso];
                                break;
                            }
                        }
                    }
                    caracteresRango[iso] = car;
                });

                const contabilizadorRango = contabilizarDias(caracteresRango);

                const item = {
                    chofer_id: c.id,
                    nombre: c.nombre,
                    legajo: c.legajo,
                    servicio: c.c_servicio,
                    diagrama_tipo: c.diagrama_tipo,
                    contabilizador: contabilizadorRango
                };

                if (formatoVal !== 'resumido') {
                    item.caracteres = caracteresRango;
                }

                resultados.push(item);
            }

            const duracion = Date.now() - t0;
            res.json({
                success: true,
                fuente: 'SUPABASE_RESTO_CONSULTA',
                latenciaMs: `${duracion}ms`,
                parametros_aplicados: {
                    desde,
                    hasta,
                    total_dias: diasRango.length,
                    chofer: choferFiltro || null,
                    legajo: legajo || null,
                    servicio: servicio || null,
                    diagrama_tipo: diagramaFiltro || null,
                    formato: formatoVal,
                    limit: limitParam || null,
                    offset: offsetParam || 0
                },
                paginacion: {
                    total_registros: totalCoincidencias,
                    retornados: resultados.length,
                    offset: offsetParam || 0,
                    hay_mas: (!isNaN(limitParam) && limitParam > 0) ? (offsetParam + resultados.length < totalCoincidencias) : false
                },
                resultados
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 3. GET /api/diagramas/mes/:mesTab — Consulta directa de pestaña mensual en Supabase
    router.get('/mes/:mesTab', async (req, res) => {
        try {
            const { mesTab } = req.params;
            const { servicio, limit, limite } = req.query;
            const limitParam = parseInt(limit || limite || '500', 10);
            const t0 = Date.now();

            let rows = [];
            if (db.isConfigured()) {
                let sql = 'SELECT * FROM diagramas WHERE mes_tab = $1';
                const params = [mesTab];
                if (servicio) {
                    sql += ' AND UPPER(servicio) = $2';
                    params.push(servicio.trim().toUpperCase());
                }
                sql += ' ORDER BY chofer_nombre ASC LIMIT $' + (params.length + 1);
                params.push(limitParam);

                const resSql = await db.query(sql, params);
                rows = resSql.rows || [];
            } else {
                let query = supabase.from('diagramas').select('*').eq('mes_tab', mesTab);
                if (servicio) query = query.eq('servicio', servicio.trim().toUpperCase());
                query = query.order('chofer_nombre').limit(limitParam);

                const { data, error } = await query;
                if (error) throw error;
                rows = data || [];
            }

            res.json({
                success: true,
                fuente: 'SUPABASE_TABLA_DIAGRAMAS',
                mes_tab: mesTab,
                servicio: servicio || 'TODOS',
                latenciaMs: `${Date.now() - t0}ms`,
                total: rows.length,
                diagramas: rows
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 4. GET /api/diagramas/chofer/:idOrNombre — Historial de un chofer específico
    router.get('/chofer/:idOrNombre', async (req, res) => {
        try {
            const { idOrNombre } = req.params;
            const norm = normalizar(idOrNombre);

            let chofer = null;
            if (db.isConfigured()) {
                const resC = await db.query(`
                    SELECT * FROM choferes 
                    WHERE id::text = $1 OR legajo = $1 OR UPPER(nombre) ILIKE $2 
                    LIMIT 1
                `, [idOrNombre, `%${idOrNombre}%`]);
                chofer = resC.rows[0] || null;
            } else {
                const { data, error } = await supabase.from('choferes').select('*').or(`id.eq.${idOrNombre},legajo.eq.${idOrNombre},nombre.ilike.%${idOrNombre}%`).limit(1);
                if (error) throw error;
                chofer = data?.[0] || null;
            }

            if (!chofer) {
                return res.status(404).json({ success: false, error: `Chofer '${idOrNombre}' no encontrado.` });
            }

            res.json({
                success: true,
                fuente: 'SUPABASE_CHOFER_REGISTRO',
                chofer: {
                    id: chofer.id,
                    nombre: chofer.nombre,
                    legajo: chofer.legajo,
                    servicio: chofer.c_servicio,
                    diagrama_tipo: chofer.diagrama_tipo,
                    estado: chofer.estado,
                    contabilizador: chofer.contabilizador,
                    diagrama_json: chofer.diagrama_json
                }
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
