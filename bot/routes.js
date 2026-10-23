const express = require('express');
const BotEngine = require('./engine');

function createBotRouter(cacheDatosGlobales) {
    const router = express.Router();
    const engine = new BotEngine(cacheDatosGlobales);

    // Consulta en lenguaje natural
    router.post('/query', async (req, res) => {
        try {
            const { pregunta, historial } = req.body;
            if (!pregunta) {
                return res.status(400).json({ success: false, error: "Falta el campo 'pregunta'." });
            }

            const resultado = await engine.procesarPregunta(pregunta, historial || []);
            res.json({
                success: true,
                ...resultado
            });
        } catch (error) {
            console.error("Error en endpoint /api/bot/query:", error);
            res.status(500).json({
                success: false,
                error: error.message || "Error interno al procesar la consulta."
            });
        }
    });

    // Métricas en vivo de la RAM para el panel superior del bot
    router.get('/stats', (req, res) => {
        const diag = cacheDatosGlobales?.diagramas;
        const uts = diag?.ut || [];
        const choferes = diag?.diagramas || [];
        const novedades = cacheDatosGlobales?.novedades || [];

        const conChofer = uts.filter(u => !!u.chofer_asignado).length;
        const sinChofer = uts.length - conChofer;
        const novedadesAbiertas = novedades.filter(n => !n.resuelto).length;

        res.json({
            success: true,
            total_choferes: choferes.length,
            total_uts: uts.length,
            uts_operativas: conChofer,
            uts_paradas: sinChofer,
            novedades_pendientes: novedadesAbiertas,
            ultima_actualizacion: cacheDatosGlobales.ultimaActualizacion,
            modo_ia: !!process.env.GEMINI_API_KEY ? "GEMINI_2.5_FLASH" : "LOCAL_RAM"
        });
    });

    // Sugerencias rápidas para la interfaz
    router.get('/sugerencias', (req, res) => {
        res.json({
            success: true,
            sugerencias: [
                { icono: "🚚", texto: "¿Quién maneja la UT 291 hoy?", categoria: "UT" },
                { icono: "📊", texto: "Resumen completo de la flota", categoria: "Flota" },
                { icono: "⚠️", texto: "¿Cuáles son las novedades de taller pendientes?", categoria: "Novedades" },
                { icono: "👤", texto: "Datos de contacto y UT asignada a Acuña", categoria: "Choferes" },
                { icono: "📍", texto: "Viajes y kilómetros de Acuña", categoria: "Viajes" },
                { icono: "⚪", texto: "¿Qué unidades están sin asignar hoy?", categoria: "Flota" },
                { icono: "📅", texto: "Días trabajados y francos de Acuña este mes", categoria: "Asistencia" },
                { icono: "🧪", texto: "Estado de unidades del servicio METANOL", categoria: "Flota" }
            ]
        });
    });

    return router;
}

module.exports = createBotRouter;
