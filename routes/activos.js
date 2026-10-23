const express = require('express');
const db = require('../utils/db');
const { supabase } = require('../utils/shared');

/**
 * Router para Activos Canónicos (Tractores, Semis) y Gestión de Acoples
 */
module.exports = function createActivosRouter(cacheDatosGlobales, io) {
    const router = express.Router();

    // GET /api/tractores — Catálogo de tractores con datos técnicos y de servicio
    router.get('/tractores', async (req, res) => {
        try {
            const { estado, patente, servicio_id } = req.query;

            let lista = cacheDatosGlobales?.tractores || [];
            if (lista.length === 0) {
                if (db.isConfigured()) {
                    const r = await db.query(`
                        SELECT t.*, su.denominacion as servicio_denominacion
                        FROM tractores t
                        LEFT JOIN servicios_unidades su ON su.id = t.servicio_id
                        ORDER BY t.patente ASC
                    `);
                    lista = r.rows;
                } else if (supabase) {
                    const { data } = await supabase.from('tractores').select('*, servicios_unidades(denominacion)').order('patente');
                    lista = data || [];
                }
            }

            let filtrados = lista;
            if (estado) {
                filtrados = filtrados.filter(t => (t.estado || '').toLowerCase() === estado.toLowerCase());
            }
            if (patente) {
                const pNorm = patente.trim().toUpperCase().replace(/\s+/g, '');
                filtrados = filtrados.filter(t => (t.patente || '').includes(pNorm));
            }
            if (servicio_id) {
                filtrados = filtrados.filter(t => t.servicio_id === servicio_id);
            }

            res.json({ success: true, total: filtrados.length, data: filtrados });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // GET /api/semis — Catálogo de semis y cisternas
    router.get('/semis', async (req, res) => {
        try {
            const { estado, patente, cisternado, servicio_id } = req.query;

            let lista = cacheDatosGlobales?.semis || [];
            if (lista.length === 0) {
                if (db.isConfigured()) {
                    const r = await db.query(`
                        SELECT s.*, su.denominacion as servicio_denominacion
                        FROM semis s
                        LEFT JOIN servicios_unidades su ON su.id = s.servicio_id
                        ORDER BY s.patente ASC
                    `);
                    lista = r.rows;
                } else if (supabase) {
                    const { data } = await supabase.from('semis').select('*, servicios_unidades(denominacion)').order('patente');
                    lista = data || [];
                }
            }

            let filtrados = lista;
            if (estado) {
                filtrados = filtrados.filter(s => (s.estado || '').toLowerCase() === estado.toLowerCase());
            }
            if (patente) {
                const pNorm = patente.trim().toUpperCase().replace(/\s+/g, '');
                filtrados = filtrados.filter(s => (s.patente || '').includes(pNorm));
            }
            if (cisternado) {
                filtrados = filtrados.filter(s => (s.cisternado || '').toLowerCase().includes(cisternado.toLowerCase()));
            }
            if (servicio_id) {
                filtrados = filtrados.filter(s => s.servicio_id === servicio_id);
            }

            res.json({ success: true, total: filtrados.length, data: filtrados });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // PUT /api/unidades/:id/acople — Modificar acople de una unidad (cambio de tractor o semi)
    router.put('/unidades/:id/acople', async (req, res) => {
        const { id } = req.params;
        const { semi_id, tractor_id, estado } = req.body;

        if (!id) return res.status(400).json({ success: false, error: 'Falta ID de unidad' });

        try {
            const ahoraIso = new Date().toISOString();
            const updatePayload = { fecha_acople: ahoraIso };
            if (semi_id !== undefined) updatePayload.semi_id = semi_id || null;
            if (tractor_id !== undefined) updatePayload.tractor_id = tractor_id || null;
            if (estado !== undefined) updatePayload.estado = estado;

            let unidadActualizada = null;

            if (db.isConfigured()) {
                const sets = ['fecha_acople = $1'];
                const values = [ahoraIso];
                let idx = 2;

                if (semi_id !== undefined) {
                    sets.push(`semi_id = $${idx++}`);
                    values.push(semi_id || null);
                }
                if (tractor_id !== undefined) {
                    sets.push(`tractor_id = $${idx++}`);
                    values.push(tractor_id || null);
                }
                if (estado !== undefined) {
                    sets.push(`estado = $${idx++}`);
                    values.push(estado);
                }

                values.push(id);
                const q = `UPDATE unidades SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`;
                const r = await db.query(q, values);
                unidadActualizada = r.rows[0];
            } else if (supabase) {
                const { data, error } = await supabase
                    .from('unidades')
                    .update(updatePayload)
                    .eq('id', id)
                    .select()
                    .single();
                if (error) throw error;
                unidadActualizada = data;
            }

            // Actualizar memoria RAM reactiva instantáneamente
            if (cacheDatosGlobales?.ut && unidadActualizada) {
                const utItem = cacheDatosGlobales.ut.find(u => u.id === id);
                if (utItem) {
                    utItem.fecha_acople = ahoraIso;
                    if (semi_id !== undefined) {
                        utItem.semi_id = semi_id;
                        const nuevoSemi = (cacheDatosGlobales.semis || []).find(s => s.id === semi_id);
                        utItem.semi = nuevoSemi ? {
                            id: nuevoSemi.id,
                            patente: nuevoSemi.patente,
                            marca: nuevoSemi.marca || '',
                            cisternado: nuevoSemi.cisternado || '',
                            vtv: nuevoSemi.vtv || '',
                            mas: nuevoSemi.mas || '',
                            esp_es: nuevoSemi.esp_es || '',
                            vi: nuevoSemi.vi || '',
                            ve: nuevoSemi.ve || '',
                            estado: nuevoSemi.estado || 'disponible'
                        } : null;
                        utItem.cisternado = utItem.semi?.cisternado || '';
                    }
                    if (tractor_id !== undefined) {
                        utItem.tractor_id = tractor_id;
                        const nuevoTr = (cacheDatosGlobales.tractores || []).find(t => t.id === tractor_id);
                        utItem.tractor = nuevoTr ? {
                            id: nuevoTr.id,
                            patente: nuevoTr.patente,
                            marca: nuevoTr.marca || '',
                            vtv: nuevoTr.vtv || '',
                            mas: nuevoTr.mas || '',
                            estado: nuevoTr.estado || 'disponible'
                        } : null;
                    }
                    if (estado !== undefined) utItem.estado = estado;
                }

                // Emitir WebSocket a los frontends
                if (io) {
                    io.emit('datos_actualizados', {
                        timestamp: ahoraIso,
                        evento: 'acople_modificado',
                        unidad_id: id,
                        ut: cacheDatosGlobales.ut
                    });
                }
            }

            res.json({
                success: true,
                message: 'Acople actualizado con éxito en Supabase y Hot RAM',
                data: unidadActualizada
            });
        } catch (err) {
            console.error('❌ Error actualizando acople:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
