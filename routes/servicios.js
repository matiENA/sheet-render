const express = require('express');
const db = require('../utils/db');
const { supabase } = require('../utils/shared');

/**
 * Router para Catálogos de Servicios (Unidades y Choferes)
 */
module.exports = function createServiciosRouter(cacheDatosGlobales) {
    const router = express.Router();

    // GET /api/servicios/unidades — Catálogo canónico de servicios de flota
    router.get('/unidades', async (req, res) => {
        try {
            if (cacheDatosGlobales?.serviciosUnidades && cacheDatosGlobales.serviciosUnidades.length > 0) {
                return res.json({ success: true, fuente: 'RAM', data: cacheDatosGlobales.serviciosUnidades });
            }

            if (db.isConfigured()) {
                const r = await db.query('SELECT * FROM servicios_unidades ORDER BY denominacion ASC');
                return res.json({ success: true, fuente: 'Postgres', data: r.rows });
            }

            if (supabase) {
                const { data, error } = await supabase.from('servicios_unidades').select('*').order('denominacion');
                if (error) throw error;
                return res.json({ success: true, fuente: 'Supabase', data: data || [] });
            }

            res.status(503).json({ success: false, error: 'Base de datos no disponible' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // GET /api/servicios/choferes — Catálogo canónico de cuentas/servicios de choferes con mapeo a servicios_unidades
    router.get('/choferes', async (req, res) => {
        try {
            if (cacheDatosGlobales?.serviciosChoferes && cacheDatosGlobales.serviciosChoferes.length > 0) {
                return res.json({ success: true, fuente: 'RAM', data: cacheDatosGlobales.serviciosChoferes });
            }

            if (db.isConfigured()) {
                const r = await db.query(`
                    SELECT sc.*, su.denominacion as servicio_unidad_denominacion
                    FROM servicios_choferes sc
                    LEFT JOIN servicios_unidades su ON su.id = sc.servicio_unidad_id
                    ORDER BY sc.denominacion ASC
                `);
                return res.json({ success: true, fuente: 'Postgres', data: r.rows });
            }

            if (supabase) {
                const { data, error } = await supabase
                    .from('servicios_choferes')
                    .select('*, servicios_unidades(denominacion)')
                    .order('denominacion');
                if (error) throw error;
                return res.json({ success: true, fuente: 'Supabase', data: data || [] });
            }

            res.status(503).json({ success: false, error: 'Base de datos no disponible' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
