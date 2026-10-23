const { GoogleGenAI } = require('@google/genai');
const { functionDeclarations, toolsMap } = require('./tools');

const SYSTEM_INSTRUCTION = `Eres el Asistente Inteligente de Operaciones y Flota de EOR Logística / UTE Transporte de Cargas.
Tienes acceso directo y en tiempo real a la memoria RAM de los servidores y al almacenamiento histórico del sistema.

CONOCIMIENTO OPERATIVO:
- UT (Unidad de Transporte): Es el conjunto formado por un tractor (camión) y un semirremolque (cisterna o batea). Cada UT tiene un número identificatorio (n_ute), patentes de tractor y semi, marcas y vencimientos (VTV, MAS, etc.).
- Servicios: La flota opera en servicios como LIVIANO, METANOL, CAMPO, CHASIS, etc.
- Choferes: Cada chofer tiene su nombre oficial, DNI, teléfono, email, legajo, UT asignada para el día, estado de asistencia en el diagrama mensual, vencimientos de carnet/médico/apto YPF y observaciones.
- Novedades: Incidencias de ruta, ingresos a taller (🔴), mantenimientos preventivos (🟡) o problemas mecánicos.
- Viajes: Registros de kilómetros, campo y hojas de ruta en el último año (RAM) y anteriores (Cold Storage).

REGLAS DE RESPUESTA:
1. Responde SIEMPRE en español de manera profesional, clara, directa y estructurada.
2. Utiliza emojis operativos para hacer la lectura ágil: 🚚 (UT/camión), 👤 (chofer), 📞 (contacto), 📅 (fechas), 📍 (rutas/km), ⚠️ (novedades/alertas), 🟢 (apto/operativo), 🔴 (vencido/taller).
3. Utiliza formato Markdown limpio: negritas, listas con viñetas y tablas cuando haya múltiples registros.
4. Siempre que te pregunten sobre un chofer, UT, flota, novedad, viaje o asistencia, INVOCA la herramienta adecuada para consultar los datos en tiempo real antes de responder. NUNCA inventes patentes, teléfonos ni números de UT.
5. Si una consulta involucra varios datos (ej: "¿Quién maneja la UT 291 y qué viajes hizo recientemente?"), puedes invocar múltiples herramientas.`;

/**
 * Motor principal de procesamiento de preguntas en lenguaje natural
 */
class BotEngine {
    constructor(cacheDatosGlobales) {
        this.cacheDatosGlobales = cacheDatosGlobales;
        this.modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        this.apiKey = process.env.GEMINI_API_KEY || '';
        this.ai = this.apiKey ? new GoogleGenAI({ apiKey: this.apiKey }) : null;
    }

    /**
     * Recarga o actualiza la clave API si cambia en caliente
     */
    actualizarApiKey(nuevaKey) {
        this.apiKey = nuevaKey || process.env.GEMINI_API_KEY || '';
        this.ai = this.apiKey ? new GoogleGenAI({ apiKey: this.apiKey }) : null;
    }

    /**
     * Procesa una pregunta en lenguaje natural y retorna la respuesta
     */
    async procesarPregunta(pregunta, historial = []) {
        const tiempoInicio = Date.now();
        const herramientasUsadas = [];

        if (!pregunta || typeof pregunta !== 'string' || !pregunta.trim()) {
            return {
                respuesta: "Por favor, escribe una pregunta sobre choferes, unidades, flota, novedades o viajes.",
                herramientas_usadas: [],
                tiempo_ms: 0
            };
        }

        // 1. Si no hay GEMINI_API_KEY, usar fallback heurístico inteligente sobre RAM
        if (!this.ai || !this.apiKey) {
            return await this.procesarFallbackHeuristico(pregunta);
        }

        // 2. Procesamiento con Gemini 2.5 Flash y Function Calling
        try {
            const chat = this.ai.chats.create({
                model: this.modelName,
                config: {
                    systemInstruction: SYSTEM_INSTRUCTION,
                    temperature: 0.2,
                    tools: [{ functionDeclarations }]
                }
            });

            // Enviar primer mensaje del usuario
            let response = await chat.sendMessage({ message: pregunta });
            let turnos = 0;
            const MAX_TURNOS = 5;

            // Bucle de resolución de Function Calls
            while (turnos < MAX_TURNOS) {
                const calls = typeof response.functionCalls === 'function' ? response.functionCalls() : response.functionCalls;
                if (!calls || calls.length === 0) {
                    break;
                }

                turnos++;
                const functionResponses = [];

                for (const call of calls) {
                    const fnName = call.name;
                    const fnArgs = call.args || {};
                    herramientasUsadas.push({ herramienta: fnName, argumentos: fnArgs });

                    let resultado = { error: `Herramienta desconocida: ${fnName}` };
                    if (toolsMap[fnName]) {
                        try {
                            resultado = await toolsMap[fnName](fnArgs, this.cacheDatosGlobales);
                        } catch (errTool) {
                            resultado = { error: `Error al ejecutar ${fnName}: ${errTool.message}` };
                        }
                    }

                    functionResponses.push({
                        functionResponse: {
                            name: fnName,
                            response: { result: resultado }
                        }
                    });
                }

                // Devolver las respuestas de las funciones al modelo
                response = await chat.sendMessage({ message: functionResponses });
            }

            const respuestaTexto = response.text || "No se pudo generar una respuesta clara.";

            return {
                respuesta: respuestaTexto,
                herramientas_usadas: herramientasUsadas,
                tiempo_ms: Date.now() - tiempoInicio,
                modelo: this.modelName,
                modo: "GEMINI_IA"
            };

        } catch (error) {
            console.error("❌ Error en Gemini BotEngine:", error);
            // Si la API falla (ej: cuota, red), acudir al fallback heurístico
            const fallback = await this.procesarFallbackHeuristico(pregunta);
            fallback.nota_error = `Gemini API devolvió un error (${error.message}). Se usó el motor local de contingencia.`;
            return fallback;
        }
    }

    /**
     * Fallback Heurístico Local:
     * Responde consultas directas sobre RAM sin requerir conexión externa o clave API.
     */
    async procesarFallbackHeuristico(pregunta) {
        const q = pregunta.toLowerCase().trim();
        const herramientasUsadas = [];
        let respuesta = "";

        // Patrón para UT (ej: "ut 291", "unidad 5", "ut5", "291")
        const matchUt = q.match(/(?:ut|unidad|ute|equipo)\s*#?\s*([a-z0-9]+)/i) || q.match(/\b([1-9][0-9]{0,2})\b/);
        // Patrón para chofer (ej: "chofer acuña", "quién maneja", "contacto de...")
        const matchChofer = q.match(/(?:chofer|conductor|maneja|telefono|tel|dni|legajo|contacto)\s+(?:de\s+)?([a-záéíóúñ]+)/i);

        if (q.includes('resumen') || q.includes('flota') || q.includes('cuantas unidades') || q.includes('cuantos camiones')) {
            herramientasUsadas.push({ herramienta: 'resumen_flota', argumentos: {} });
            const res = await toolsMap.resumen_flota({}, this.cacheDatosGlobales);
            respuesta = `📊 **Resumen en Vivo de la Flota (RAM)**\n\n` +
                `- 🚚 **Total de UTs:** ${res.total_unidades}\n` +
                `- 🟢 **Operativas (con chofer asignado):** ${res.operativas_con_chofer}\n` +
                `- ⚪ **Disponibles / Paradas (sin chofer):** ${res.paradas_sin_chofer}\n` +
                `- ⚠️ **Novedades de flota pendientes:** ${res.novedades_pendientes_flota}\n\n` +
                `**Desglose por Servicio:**\n` +
                Object.entries(res.desglose_por_servicio || {}).map(([srv, data]) => 
                    `  • **${srv}:** ${data.total} unidades (${data.conChofer} activas, ${data.sinChofer} sin asignar)`
                ).join('\n');

        } else if (q.includes('novedad') || q.includes('taller') || q.includes('rotura') || q.includes('incidente')) {
            herramientasUsadas.push({ herramienta: 'consultar_novedades', argumentos: { solo_pendientes: true } });
            const res = await toolsMap.consultar_novedades({ solo_pendientes: true }, this.cacheDatosGlobales);
            if (res.total_encontradas === 0) {
                respuesta = `🟢 **No hay novedades operativas pendientes en este momento.**`;
            } else {
                respuesta = `⚠️ **Novedades Operativas Pendientes (${res.total_encontradas}):**\n\n` +
                    res.novedades.map(n => 
                        `- **${n.fecha}** | UT: **${n.ut || 'S/D'}** | Chofer: **${n.chofer || 'S/D'}**\n  *${n.descripcion}*`
                    ).join('\n\n');
            }

        } else if (matchUt) {
            const utNum = matchUt[1];
            herramientasUsadas.push({ herramienta: 'consultar_ut', argumentos: { query: utNum } });
            const res = await toolsMap.consultar_ut({ query: utNum }, this.cacheDatosGlobales);
            if (res.encontrado) {
                respuesta = `🚚 **Unidad de Transporte UT ${res.n_ute}**\n\n` +
                    `- **Servicio:** ${res.servicio}\n` +
                    `- **Estado:** ${res.estado_operativo}\n` +
                    `- **Chofer asignado hoy:** ${res.chofer_asignado ? `👤 **${res.chofer_asignado}**` : '⚪ *Sin asignar*'}\n` +
                    `- **Tractor:** ${res.tractor?.patente || 'N/A'} (${res.tractor?.marca || 'S/M'})\n` +
                    `- **Semirremolque:** ${res.semi?.patente || 'N/A'} (${res.semi?.marca || 'S/M'})${res.semi?.cisternado ? ` - Cisterna: ${res.semi.cisternado}` : ''}\n`;
                if (res.novedades_activas && res.novedades_activas.length > 0) {
                    respuesta += `\n⚠️ **Novedades activas:**\n` +
                        res.novedades_activas.map(n => `  • [${n.fecha}] ${n.descripcion}`).join('\n');
                }
            } else {
                respuesta = res.mensaje || `No se encontró la UT ${utNum}.`;
            }

        } else if (matchChofer) {
            const chName = matchChofer[1];
            herramientasUsadas.push({ herramienta: 'consultar_chofer', argumentos: { query: chName } });
            const res = await toolsMap.consultar_chofer({ query: chName }, this.cacheDatosGlobales);
            if (res.encontrado) {
                respuesta = `👤 **Chofer: ${res.nombre}**\n\n` +
                    `- **DNI:** ${res.dni || 'S/D'} | **Servicio:** ${res.servicio}\n` +
                    `- **Contacto:** 📞 ${res.contacto?.telefono || 'S/D'} | ✉️ ${res.contacto?.email || 'S/D'} | Legajo: ${res.contacto?.legajo || 'S/D'}\n` +
                    `- **UT Asignada hoy:** ${res.ut_asignada ? `🚚 **UT ${res.ut_asignada.n_ute}** (${res.ut_asignada.tractor?.patente || ''} / ${res.ut_asignada.semi?.patente || ''})` : '⚪ *Sin UT asignada hoy*'}\n` +
                    `- **Vencimientos:**\n` +
                    `  • Licencia: ${res.documentos?.vencimiento_licencia || 'S/D'}\n` +
                    `  • Médico: ${res.documentos?.vencimiento_medico || 'S/D'}\n` +
                    `  • Apto Médico: ${res.documentos?.apto_medico || 'S/D'}\n`;
                if (res.viajes && res.viajes.total_viajes_ram > 0) {
                    respuesta += `- **Viajes en RAM:** ${res.viajes.total_viajes_ram} viajes (${res.viajes.total_km_ram} km)`;
                }
            } else if (res.coincidencias) {
                respuesta = `${res.mensaje}\n` + res.coincidencias.map(c => `• ${c.nombre} (DNI: ${c.dni})`).join('\n');
            } else {
                respuesta = res.mensaje || `No se encontró ningún chofer con el nombre "${chName}".`;
            }

        } else {
            respuesta = `Hola. Soy el asistente operativo de la flota. Puedes preguntarme sobre:\n\n` +
                `• **Choferes:** *"¿Quién es Acuña?", "Teléfono y DNI de Gómez"*\n` +
                `• **Unidades (UT):** *"¿Quién tiene la UT 291 hoy?", "Estado de la UT 5"*\n` +
                `• **Flota en general:** *"Resumen de flota", "¿Cuántos camiones hay en taller?"*\n` +
                `• **Novedades:** *"Novedades pendientes", "Últimas roturas"*\n` +
                `• **Viajes:** *"Viajes de Acuña este mes"*\n\n` +
                `> 💡 *Tip: Puedes configurar la clave \`GEMINI_API_KEY\` en \`.env\` para habilitar el razonamiento conversacional completo con IA.*`;
        }

        return {
            respuesta,
            herramientas_usadas: herramientasUsadas,
            tiempo_ms: 5,
            modo: "LOCAL_RAM_FALLBACK"
        };
    }
}

module.exports = BotEngine;
