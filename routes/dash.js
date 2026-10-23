const express = require('express');

/**
 * Router dedicado para el Dashboard.
 * Expone endpoints ligeros que devuelven solo lo que DASH necesita,
 * sin enviar la estructura completa de diagramas/días/ISO.
 */
module.exports = function createDashRouter(cacheDatosGlobales, io, ioDash = null) {
    const router = express.Router();

    // GET /api/dash/flota — Lista ligera para autocompletado y enriquecimiento
    // Devuelve estructura limpia: _safeId, nom, srv_chofer, ut, dias
    router.get('/flota', (req, res) => {
        if (!cacheDatosGlobales.diagramas || !cacheDatosGlobales.diagramas.diagramas) {
            return res.status(503).json({ error: "Cargando DB..." });
        }

        const flotaLite = cacheDatosGlobales.diagramas.diagramas.map(ch => ({
            _safeId: ch._safeId,
            nom: ch.nom,
            srv_chofer: ch.srv_chofer || 'S/A',
            dni: ch.dni || '',
            foto: ch.foto || '',
            ut: ch.ut || null,
            tractor: ch.tractor || ch.ut?.tractor?.patente || '',
            semi: ch.semi || ch.ut?.semi?.patente || '',
            cisternado: ch.cisternado || ch.ut?.semi?.cisternado || ch.ut?.tractor?.semi?.cisternado || ch.ut?.tractor?.cisternado || '',
            n_ute: ch.n_ute || ch.ut?.n_ute || '',
            dias: ch.dias || {},
            diagrama_tipo: ch.diagrama_tipo || null,
            diagrama_json: ch.diagrama_json || null,
            contabilizador: ch.contabilizador || null
        }));

        res.json({
            success: true,
            flota: flotaLite,
            ut: cacheDatosGlobales.diagramas.ut || [],
            unidades: cacheDatosGlobales.diagramas.unidades || [],
            utMap: cacheDatosGlobales.diagramas.utMap || {},
            // Flota indexada por nombre normalizado para búsqueda rápida
            flotaMap: cacheDatosGlobales.diagramas.flota || {},
            tractores: cacheDatosGlobales.tractores || cacheDatosGlobales.diagramas?.tractores || [],
            semis: cacheDatosGlobales.semis || cacheDatosGlobales.diagramas?.semis || [],
            servicios_unidades: cacheDatosGlobales.serviciosUnidades || cacheDatosGlobales.diagramas?.servicios_unidades || [],
            servicios_choferes: cacheDatosGlobales.serviciosChoferes || cacheDatosGlobales.diagramas?.servicios_choferes || [],
            usuarios: cacheDatosGlobales.usuarios || [],
            timestamp: cacheDatosGlobales.ultimaActualizacion
        });
    });

    // GET /api/dash/ut o /api/dash/unidades — Catálogo completo de unidades de Movimientos
    router.get(['/ut', '/unidades'], (req, res) => {
        res.json({
            success: true,
            data: (cacheDatosGlobales.diagramas && (cacheDatosGlobales.diagramas.ut || cacheDatosGlobales.diagramas.unidades)) || []
        });
    });

    // GET /api/dash/novedades — Novedades para el Dashboard
    router.get('/novedades', (req, res) => {
        res.json({
            success: true,
            data: cacheDatosGlobales.novedades || []
        });
    });

    // GET /api/dash/usuarios — Lista de usuarios para @menciones
    router.get('/usuarios', (req, res) => {
        res.json({
            success: true,
            data: cacheDatosGlobales.usuarios || []
        });
    });

    // ⚡ Caché en memoria para fichas individuales de chofer (evita saturar Supabase y reduce egress a 0)
    const cacheLegajo = new Map();
    const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    async function resolverChoferId(identificador, supabase) {
        if (!identificador) return null;
        const str = String(identificador).trim();
        if (UUID_REGEX.test(str)) return str;

        const { normalizar } = require('../utils/shared');
        const norm = normalizar(str);
        const cleanNum = str.replace(/\D/g, '');

        // 1. Buscar en cacheDatosGlobales en RAM
        const lista = cacheDatosGlobales?.diagramas?.diagramas || [];
        const chEnCache = lista.find(c => {
            if (c.id && UUID_REGEX.test(c.id)) {
                if (c._safeId === str) return true;
                if (c.dni && cleanNum && String(c.dni).replace(/\D/g, '') === cleanNum) return true;
                if (c.legajo && c.legajo === str) return true;
                const normC = normalizar(c.nom);
                if (normC === norm) return true;
                if (norm.includes('ñ') && normC.replace(/ñ/g, 'n') === norm.replace(/ñ/g, 'n')) return true;
            }
            return false;
        });
        if (chEnCache?.id) return chEnCache.id;

        // 2. Buscar en Supabase 'choferes'
        if (supabase) {
            try {
                let query = supabase.from('choferes').select('id, nombre, dni, legajo');
                if (cleanNum && cleanNum.length >= 6) {
                    query = query.or(`dni.eq.${cleanNum},nombre.ilike.%${str}%,legajo.eq.${str}`);
                } else {
                    query = query.or(`nombre.ilike.%${str}%,legajo.eq.${str}`);
                }
                const { data } = await query.limit(1).maybeSingle();
                if (data?.id) return data.id;
            } catch (e) {}

            // 3. Buscar en 'chofer_documentacion' por drv_codigo, dni o cuil
            try {
                let docQuery = supabase.from('chofer_documentacion').select('chofer_id');
                if (cleanNum) {
                    docQuery = docQuery.or(`drv_codigo.eq.${str},dni.eq.${cleanNum},cuil.ilike.%${cleanNum}%`);
                } else {
                    docQuery = docQuery.eq('drv_codigo', str);
                }
                const { data: docData } = await docQuery.limit(1).maybeSingle();
                if (docData?.chofer_id) return docData.chofer_id;
            } catch (e) {}
        }

        return null;
    }

    // GET /api/dash/chofer/:id/legajo — Ficha documental y observaciones bajo demanda (para dropdowns de vista individual)
    router.get('/chofer/:id/legajo', async (req, res) => {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: "Falta id de chofer" });

        const now = Date.now();
        const cached = cacheLegajo.get(id);
        if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
            return res.json({ success: true, cached: true, ...cached.data });
        }

        try {
            const { supabase } = require('../utils/shared');
            if (!supabase) return res.status(500).json({ error: "Supabase no configurado" });

            const choferId = await resolverChoferId(id, supabase);
            if (!choferId) {
                return res.status(404).json({ success: false, error: `Chofer '${id}' no encontrado en Supabase.` });
            }

            // Consultar documentación y observaciones en paralelo
            const [docRes, obsRes] = await Promise.all([
                supabase.from('chofer_documentacion').select('*').eq('chofer_id', choferId).maybeSingle(),
                supabase.from('chofer_observaciones').select('*').eq('chofer_id', choferId).order('fecha', { ascending: false })
            ]);

            const payload = {
                chofer_id: choferId,
                documentacion: docRes.data || null,
                observaciones: obsRes.data || []
            };

            cacheLegajo.set(id, { timestamp: now, data: payload });
            cacheLegajo.set(choferId, { timestamp: now, data: payload });

            res.json({
                success: true,
                cached: false,
                ...payload
            });
        } catch (err) {
            console.error("Error consultando legajo de chofer:", err);
            res.status(500).json({ error: "Error consultando legajo", detalle: err.message });
        }
    });

    // PUT /api/dash/chofer/:id/legajo o /documentos — Actualizar documentación directamente en Supabase
    router.put(['/chofer/:id/legajo', '/chofer/:id/documentos'], async (req, res) => {
        const { id } = req.params;
        const updates = req.body || {};
        try {
            const { supabase } = require('../utils/shared');
            if (!supabase) return res.status(500).json({ error: "Supabase no configurado" });

            const choferId = await resolverChoferId(id, supabase);
            if (!choferId) {
                return res.status(404).json({ success: false, error: `Chofer '${id}' no encontrado.` });
            }

            // Filtrar campos válidos para chofer_documentacion
            const validCols = [
                'venc_licencia_nacional', 'venc_psicofisico', 'venc_cargas_peligrosas', 'venc_periodico',
                'venc_curso_shell', 'venc_manejo_def', 'curso_pae', 'apto_medico_venc', 'apto_medico_estado',
                'avalado_contratos', 'vacuna_antitetanica', 'metabolitos_7', 'vacuna_covid', 'dosis_covid',
                'obs_documentacion', 'telefono', 'email', 'domicilio', 'localidad', 'telefono_emergencia'
            ];

            const dbPayload = { actualizado_el: new Date().toISOString() };
            validCols.forEach(col => {
                if (updates[col] !== undefined) dbPayload[col] = updates[col];
            });

            // Compatibilidad con parámetros exVen / licVen / certVen del frontend
            if (updates.exVen) dbPayload.venc_periodico = updates.exVen;
            if (updates.licVen) dbPayload.venc_licencia_nacional = updates.licVen;
            if (updates.certVen) dbPayload.venc_cargas_peligrosas = updates.certVen;

            const { data, error } = await supabase
                .from('chofer_documentacion')
                .update(dbPayload)
                .eq('chofer_id', choferId)
                .select()
                .maybeSingle();

            if (error) throw error;

            // Invalidar caché
            cacheLegajo.delete(id);
            cacheLegajo.delete(choferId);

            res.json({
                success: true,
                message: "Documentación actualizada en Supabase",
                documentacion: data
            });
        } catch (err) {
            console.error("Error actualizando legajo:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // POST /api/dash/chofer/:id/observaciones — Registrar nueva observación en Supabase
    router.post('/chofer/:id/observaciones', async (req, res) => {
        const { id } = req.params;
        const obs = req.body || {};
        try {
            const { supabase } = require('../utils/shared');
            if (!supabase) return res.status(500).json({ error: "Supabase no configurado" });

            const choferId = await resolverChoferId(id, supabase);
            if (!choferId) {
                return res.status(404).json({ success: false, error: `Chofer '${id}' no encontrado.` });
            }

            const nuevaObs = {
                chofer_id: choferId,
                fecha: obs.fecha || new Date().toISOString().split('T')[0],
                unidad_dominio: obs.unidad || obs.unidad_dominio || null,
                evento: obs.evento || 'Observación general',
                obs_evento: obs.obsEvento || obs.obs_evento || '',
                estado: obs.estado || 'PENDIENTE',
                obs_estado: obs.obsEstado || obs.obs_estado || '',
                admin_carga: obs.admin || obs.usuario || obs.admin_carga || 'Sistema'
            };

            const { data, error } = await supabase
                .from('chofer_observaciones')
                .insert([nuevaObs])
                .select()
                .single();

            if (error) throw error;

            // Invalidar caché
            cacheLegajo.delete(id);
            cacheLegajo.delete(choferId);

            res.json({
                success: true,
                message: "Observación registrada en Supabase",
                observacion: data
            });
        } catch (err) {
            console.error("Error insertando observación:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ==============================================================
    // 🔄 DOBLE ESCRITURA: CAMBIO DE UNIDAD (BD + RAM + GOOGLE SHEETS)
    // ==============================================================
    function colIndexToA1(index) {
        let col = '';
        let temp = index;
        while (temp >= 0) {
            col = String.fromCharCode((temp % 26) + 65) + col;
            temp = Math.floor(temp / 26) - 1;
        }
        return col;
    }

    async function sincronizarCambioUnidadEnSheets({ choferNombre, tractor, semi, n_ute, esDesasignar = false }) {
        try {
            const { getTabName, fetchRango, serviceAccountAuth, ID_SHEET_MOVIMIENTOS, mesesAbrev, mesesLargo, getFechaArgentina, normalizar } = require('../utils/shared');
            if (!serviceAccountAuth || !ID_SHEET_MOVIMIENTOS) {
                console.warn("⚠️ [Sheets Double-Write] Google Sheets no configurado.");
                return { success: false, reason: "Sheets no configurado" };
            }

            const tabName = await getTabName(ID_SHEET_MOVIMIENTOS, "Mov.Unidades", "SEPTIEMBRE 2026- Mov.Unidades y Choferes");
            const rows = await fetchRango(ID_SHEET_MOVIMIENTOS, `'${tabName}'!A1:ZZ350`);
            if (!rows || rows.length === 0) return { success: false, reason: "Planilla vacía" };

            const row0 = rows[0] || [];
            const hoyAr = getFechaArgentina();

            function parseHeaderDate(str) {
                if (!str) return null;
                let clean = String(str).toLowerCase().replace(/\s+/g, ' ').trim();
                let matchWord = clean.match(/(\d{1,2})[\s/\-de]+([a-z]+)[\s/\-de]+(\d{2,4})/);
                if (matchWord) {
                    let day = parseInt(matchWord[1], 10);
                    let mStr = matchWord[2].substring(0, 3);
                    let monthIdx = mesesAbrev.map(m => m.toLowerCase()).indexOf(mStr);
                    if (monthIdx === -1) monthIdx = mesesLargo.map(m => m.toLowerCase()).indexOf(matchWord[2]);
                    let year = parseInt(matchWord[3], 10);
                    if (year < 100) year += 2000;
                    if (monthIdx !== -1 && day >= 1 && day <= 31) return new Date(year, monthIdx, day);
                }
                let matchSlash = clean.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
                if (matchSlash) {
                    let day = parseInt(matchSlash[1], 10);
                    let monthIdx = parseInt(matchSlash[2], 10) - 1;
                    let year = parseInt(matchSlash[3], 10);
                    if (year < 100) year += 2000;
                    return new Date(year, monthIdx, day);
                }
                return null;
            }

            let dateMap = [];
            row0.forEach((cell, idx) => {
                const d = parseHeaderDate(cell);
                if (d) dateMap.push({ colFecha: idx, colNom: Math.max(0, idx - 3), dateObj: d });
            });

            const todayStr = hoyAr.toISOString().split('T')[0];
            let targetCol = dateMap.find(d => d.dateObj.toISOString().split('T')[0] === todayStr);
            if (!targetCol) {
                const validPast = dateMap.filter(d => d.dateObj <= hoyAr).sort((a, b) => b.dateObj - a.dateObj);
                if (validPast.length > 0) targetCol = validPast[0];
                else if (dateMap.length > 0) targetCol = dateMap[0];
            }

            if (!targetCol) {
                console.warn("⚠️ [Sheets Double-Write] Columna de fecha operativa no encontrada.");
                return { success: false, reason: "Columna de fecha no encontrada" };
            }

            const colChoferIndex = targetCol.colNom;
            const colLetter = colIndexToA1(colChoferIndex);
            const normChoferBuscado = normalizar(choferNombre);

            const cleanTractor = (tractor || '').toUpperCase().replace(/\s+/g, '');
            const cleanSemi = (semi || '').toUpperCase().replace(/\s+/g, '');
            const cleanUte = String(n_ute || '').trim();

            let rowTargetIdx = -1;
            let rowOldIdx = -1;

            for (let i = 1; i < rows.length; i++) {
                const r = rows[i];
                if (!r || r.length === 0) continue;

                const rUte = String(r[2] || '').trim();
                const rTrac = String(r[4] || '').toUpperCase().replace(/\s+/g, '');
                const rSemi = String(r[5] || '').toUpperCase().replace(/\s+/g, '');
                const rChofer = String(r[colChoferIndex] || '').trim();
                const normRChofer = normalizar(rChofer);

                if (rChofer && (normRChofer === normChoferBuscado || normRChofer.replace(/ñ/g, 'n') === normChoferBuscado.replace(/ñ/g, 'n'))) {
                    rowOldIdx = i + 1;
                }

                if (!esDesasignar && rowTargetIdx === -1) {
                    if ((cleanTractor && rTrac === cleanTractor) ||
                        (cleanSemi && rSemi === cleanSemi) ||
                        (cleanUte && cleanUte !== '-' && rUte === cleanUte)) {
                        rowTargetIdx = i + 1;
                    }
                }
            }

            const batchUpdates = [];
            // Borrar de fila anterior si cambió de unidad
            if (rowOldIdx !== -1 && rowOldIdx !== rowTargetIdx) {
                batchUpdates.push({
                    range: `'${tabName}'!${colLetter}${rowOldIdx}`,
                    values: [['']]
                });
            }

            // Escribir en la nueva fila
            if (!esDesasignar && rowTargetIdx !== -1) {
                batchUpdates.push({
                    range: `'${tabName}'!${colLetter}${rowTargetIdx}`,
                    values: [[choferNombre.trim().toUpperCase()]]
                });
            }

            if (batchUpdates.length > 0) {
                await serviceAccountAuth.request({
                    url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_MOVIMIENTOS}/values:batchUpdate`,
                    method: 'POST',
                    data: {
                        valueInputOption: 'USER_ENTERED',
                        data: batchUpdates
                    }
                });
                console.log(`✅ [Sheets Double-Write] Asignación reflejada en Google Sheets ('${tabName}'): '${choferNombre}' -> Fila ${rowTargetIdx || 'desasignado'}`);
            }

            return { success: true, count: batchUpdates.length };
        } catch (err) {
            console.error("❌ [Sheets Double-Write] Error en sincronización con Sheets:", err.message);
            return { success: false, error: err.message };
        }
    }

    // POST /api/dash/asignar-unidad (y alias /cambiar-unidad, /chofer/:id/unidad)
    router.post(['/asignar-unidad', '/cambiar-unidad', '/chofer/:id/unidad'], async (req, res) => {
        try {
            const body = req.body || {};
            const idParam = req.params?.id;
            const identificadorChofer = idParam || body.id_chofer || body.chofer_id || body.id || body.safeId || body.nombre;

            if (!identificadorChofer) {
                return res.status(400).json({ success: false, error: "Identificador de chofer requerido (id_chofer, safeId o nombre)" });
            }

            const { supabase, normalizar } = require('../utils/shared');
            const db = require('../utils/db');

            // 1. Resolver chofer
            let targetChoferId = await resolverChoferId(identificadorChofer, supabase);
            let choferEnCache = null;
            const listaChoferesRAM = cacheDatosGlobales?.diagramas?.diagramas || [];

            if (targetChoferId) {
                choferEnCache = listaChoferesRAM.find(c => c.id === targetChoferId);
            }
            if (!choferEnCache) {
                const normIdent = normalizar(identificadorChofer);
                choferEnCache = listaChoferesRAM.find(c => c._safeId === identificadorChofer || normalizar(c.nom) === normIdent || normalizar(c.nom).replace(/ñ/g, 'n') === normIdent.replace(/ñ/g, 'n'));
                if (choferEnCache?.id && !targetChoferId) {
                    targetChoferId = choferEnCache.id;
                }
            }

            if (!targetChoferId && supabase) {
                const { data: chDb } = await supabase.from('choferes').select('id, nombre').ilike('nombre', `%${body.nombre || identificadorChofer}%`).limit(1).maybeSingle();
                if (chDb?.id) {
                    targetChoferId = chDb.id;
                    if (!choferEnCache) {
                        choferEnCache = listaChoferesRAM.find(c => c.id === targetChoferId);
                    }
                }
            }

            if (!targetChoferId) {
                return res.status(404).json({ success: false, error: `Chofer '${identificadorChofer}' no encontrado en la base de datos.` });
            }

            const choferNombre = body.nombre || choferEnCache?.nom || 'CHOFER';
            const normChofer = normalizar(choferNombre);

            // 2. Resolver unidad
            let targetUnidadId = body.id_unidad || body.unidad_id || null;
            if (targetUnidadId === 'null' || targetUnidadId === 'undefined' || targetUnidadId === '') {
                targetUnidadId = null;
            }

            let unidadObj = null;
            const listaUtRAM = cacheDatosGlobales?.diagramas?.ut || [];

            if (targetUnidadId) {
                unidadObj = listaUtRAM.find(u => u.id === targetUnidadId);
            }

            // Si no se proveyó id_unidad pero sí tractor/semi/n_ute, buscar en BD o RAM
            const tractorInput = (body.tractor || '').toUpperCase().replace(/\s+/g, '');
            const semiInput = (body.semi || '').toUpperCase().replace(/\s+/g, '');
            const uteInput = String(body.n_ute || '').trim();

            if (!targetUnidadId && (tractorInput || semiInput || uteInput)) {
                if (listaUtRAM.length > 0) {
                    unidadObj = listaUtRAM.find(u => {
                        const trPat = (u.tractor?.patente || u.tractor || '').toUpperCase().replace(/\s+/g, '');
                        const sePat = (u.semi?.patente || u.semi || '').toUpperCase().replace(/\s+/g, '');
                        if (tractorInput && trPat === tractorInput) return true;
                        if (semiInput && sePat === semiInput) return true;
                        if (uteInput && uteInput !== '-' && String(u.n_ute).trim() === uteInput) return true;
                        return false;
                    });
                    if (unidadObj?.id) targetUnidadId = unidadObj.id;
                }

                if (!targetUnidadId && supabase) {
                    if (tractorInput) {
                        const { data: tData } = await supabase.from('tractores').select('id').ilike('patente', `%${tractorInput}%`).limit(1).maybeSingle();
                        if (tData?.id) {
                            const { data: uData } = await supabase.from('unidades').select('id').eq('tractor_id', tData.id).limit(1).maybeSingle();
                            if (uData?.id) targetUnidadId = uData.id;
                        }
                    } else if (semiInput) {
                        const { data: sData } = await supabase.from('semis').select('id').ilike('patente', `%${semiInput}%`).limit(1).maybeSingle();
                        if (sData?.id) {
                            const { data: uData } = await supabase.from('unidades').select('id').eq('semi_id', sData.id).limit(1).maybeSingle();
                            if (uData?.id) targetUnidadId = uData.id;
                        }
                    } else if (uteInput && uteInput !== '-') {
                        const { data: uData } = await supabase.from('unidades').select('id').eq('n_ute', uteInput).limit(1).maybeSingle();
                        if (uData?.id) targetUnidadId = uData.id;
                    }
                }
            }

            const esDesasignar = !targetUnidadId;
            const tractorFinal = unidadObj?.tractor?.patente || unidadObj?.tractor || tractorInput || '';
            const semiFinal = unidadObj?.semi?.patente || unidadObj?.semi || semiInput || '';
            const uteFinal = unidadObj?.n_ute || uteInput || '';

            // 3. Persistencia en Base de Datos (movimientos y choferes)
            if (db.isConfigured()) {
                try {
                    if (esDesasignar) {
                        await db.query(`DELETE FROM movimientos WHERE id_chofer = $1`, [targetChoferId]);
                        await db.query(`UPDATE choferes SET unidad_id = NULL, estado = 'inactivo', actualizado_el = NOW() WHERE id = $1`, [targetChoferId]);
                    } else {
                        // Eliminar asignación previa de este chofer o de esta unidad
                        await db.query(`DELETE FROM movimientos WHERE id_chofer = $1 OR id_unidad = $2`, [targetChoferId, targetUnidadId]);
                        await db.query(`INSERT INTO movimientos (id, id_unidad, id_chofer) VALUES (gen_random_uuid(), $1, $2)`, [targetUnidadId, targetChoferId]);
                        await db.query(`UPDATE choferes SET unidad_id = $1, estado = 'circulando', actualizado_el = NOW() WHERE id = $2`, [targetUnidadId, targetChoferId]);
                        await db.query(`UPDATE unidades SET estado = 'circulando' WHERE id = $1`, [targetUnidadId]);
                    }
                } catch (ePg) {
                    console.warn("⚠️ [dash] Error en pg directo, usando fallback supabase:", ePg.message);
                }
            }

            if (supabase) {
                try {
                    if (esDesasignar) {
                        await supabase.from('movimientos').delete().eq('id_chofer', targetChoferId);
                        await supabase.from('choferes').update({ unidad_id: null, estado: 'inactivo', actualizado_el: new Date().toISOString() }).eq('id', targetChoferId);
                    } else {
                        await supabase.from('movimientos').delete().or(`id_chofer.eq.${targetChoferId},id_unidad.eq.${targetUnidadId}`);
                        await supabase.from('movimientos').insert([{ id_unidad: targetUnidadId, id_chofer: targetChoferId }]);
                        await supabase.from('choferes').update({ unidad_id: targetUnidadId, estado: 'circulando', actualizado_el: new Date().toISOString() }).eq('id', targetChoferId);
                        await supabase.from('unidades').update({ estado: 'circulando' }).eq('id', targetUnidadId);
                    }
                } catch (eSupa) {
                    console.error("❌ Error persistiendo movimiento en Supabase:", eSupa.message);
                }
            }

            // 4. Actualización instantánea en memoria RAM (cacheDatosGlobales)
            if (cacheDatosGlobales.diagramas) {
                // A. Actualizar Chofer
                if (choferEnCache) {
                    if (esDesasignar) {
                        if (choferEnCache.ut) {
                            choferEnCache.ut.chofer_asignado = null;
                        }
                        choferEnCache.ut = null;
                        choferEnCache.tractor = '';
                        choferEnCache.semi = '';
                        choferEnCache.n_ute = '';
                        choferEnCache.cisternado = '';
                        choferEnCache.estado = 'inactivo';
                    } else {
                        if (choferEnCache.ut && choferEnCache.ut !== unidadObj) {
                            choferEnCache.ut.chofer_asignado = null;
                        }
                        choferEnCache.ut = unidadObj;
                        choferEnCache.tractor = tractorFinal;
                        choferEnCache.semi = semiFinal;
                        choferEnCache.n_ute = uteFinal;
                        choferEnCache.cisternado = unidadObj?.cisternado || '';
                        choferEnCache.estado = 'circulando';
                    }
                }

                // B. Actualizar Unidad en RAM
                if (unidadObj && !esDesasignar) {
                    if (unidadObj.chofer_asignado && unidadObj.chofer_asignado.nom !== choferNombre) {
                        const oldChNom = normalizar(unidadObj.chofer_asignado.nom);
                        const oldCh = listaChoferesRAM.find(c => normalizar(c.nom) === oldChNom || (oldChNom.includes('ñ') && normalizar(c.nom).replace(/ñ/g, 'n') === oldChNom.replace(/ñ/g, 'n')));
                        if (oldCh && oldCh.id !== targetChoferId) {
                            oldCh.ut = null;
                            oldCh.tractor = '';
                            oldCh.semi = '';
                            oldCh.n_ute = '';
                            oldCh.cisternado = '';
                            oldCh.estado = 'inactivo';
                        }
                    }
                    unidadObj.chofer_asignado = {
                        nom: choferNombre,
                        _safeId: choferEnCache?._safeId || ('drv_' + normChofer.replace(/[^a-z0-9]/g, '_'))
                    };
                }

                // C. Actualizar flotaMap
                if (cacheDatosGlobales.diagramas.flota) {
                    cacheDatosGlobales.diagramas.flota[normChofer] = {
                        tractor: tractorFinal,
                        semi: semiFinal,
                        servicio: choferEnCache?.srv || 'S/A',
                        n_ute: uteFinal,
                        cisternado: unidadObj?.cisternado || '',
                        ut: esDesasignar ? null : unidadObj
                    };
                }

                // D. Broadcast Socket.io
                if (io || ioDash) {
                    const { buildSocketPayload } = require('../cache/builder');
                    const payload = buildSocketPayload(cacheDatosGlobales);
                    if (io) io.emit('datos_actualizados', payload);
                    if (ioDash) ioDash.emit('datos_actualizados', payload);
                }
            }

            // 5. Doble Escritura en Google Sheets (asíncrona y no bloqueante)
            sincronizarCambioUnidadEnSheets({
                choferNombre,
                tractor: tractorFinal,
                semi: semiFinal,
                n_ute: uteFinal,
                esDesasignar
            }).catch(e => console.warn("⚠️ [Sheets Double-Write] Falla no bloqueante:", e.message));

            cacheLegajo.delete(targetChoferId);
            if (choferEnCache?._safeId) cacheLegajo.delete(choferEnCache._safeId);

            res.json({
                success: true,
                message: esDesasignar ? "Unidad desasignada exitosamente" : "Unidad asignada exitosamente",
                id_chofer: targetChoferId,
                id_unidad: targetUnidadId,
                chofer: choferNombre,
                tractor: tractorFinal,
                semi: semiFinal,
                n_ute: uteFinal
            });

        } catch (err) {
            console.error("❌ Error en /api/dash/asignar-unidad:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
