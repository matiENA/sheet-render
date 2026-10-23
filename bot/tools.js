const { normalizar, fetchRango, ID_SHEET_KILOMETROS, mesesAbrev } = require('../utils/shared');
const { isMicroservicioActivo, obtenerHistorialMicroservicio } = require('../utils/kmClient');

/**
 * Normaliza un string para comparaciones tolerantes a acentos, diacríticos y mayúsculas.
 */
function limpiarTexto(str) {
    if (!str) return '';
    return normalizar(String(str))
        .replace(/ñ/g, 'n')
        .toLowerCase()
        .trim();
}

/**
 * Herramienta 1: Consultar datos de un chofer
 */
async function consultarChofer(args, cacheDatosGlobales) {
    const { query } = args;
    if (!query || !cacheDatosGlobales?.diagramas?.diagramas) {
        return { error: "No se proporcionó un nombre/DNI o los datos aún no están cargados en memoria." };
    }

    const q = limpiarTexto(query);
    const qNum = String(query).replace(/\D/g, '');
    const choferes = cacheDatosGlobales.diagramas.diagramas;

    // Buscar coincidencias
    const coincidencias = choferes.filter(ch => {
        const nom = limpiarTexto(ch.nom);
        const dni = String(ch.dni || '').replace(/\D/g, '');
        if (qNum && dni.includes(qNum)) return true;
        if (nom.includes(q)) return true;
        return false;
    });

    if (coincidencias.length === 0) {
        return { mensaje: `No se encontró ningún chofer que coincida con "${query}".` };
    }

    // Si hay varias coincidencias pero una es exacta
    let seleccionado = coincidencias.find(ch => limpiarTexto(ch.nom) === q || String(ch.dni) === qNum);
    if (!seleccionado && coincidencias.length === 1) {
        seleccionado = coincidencias[0];
    }

    if (!seleccionado && coincidencias.length > 1) {
        return {
            mensaje: `Se encontraron ${coincidencias.length} choferes similares. Especifica mejor el nombre o DNI:`,
            coincidencias: coincidencias.slice(0, 8).map(ch => ({
                nombre: ch.nom,
                dni: ch.dni,
                servicio: ch.srv_chofer,
                ut_asignada: ch.ut?.n_ute || 'Sin UT'
            }))
        };
    }

    // Calcular resumen de viajes en RAM
    let resumenViajes = { total_viajes_ram: 0, total_km_ram: 0 };
    if (seleccionado.viajes && typeof seleccionado.viajes === 'object') {
        const fechas = Object.keys(seleccionado.viajes);
        resumenViajes.total_viajes_ram = fechas.length;
        resumenViajes.total_km_ram = fechas.reduce((acc, f) => acc + (seleccionado.viajes[f].km || 0), 0);
        resumenViajes.ultimos_viajes = fechas.sort().reverse().slice(0, 3).map(f => ({
            fecha: f,
            km: seleccionado.viajes[f].km,
            hoja_ruta: seleccionado.viajes[f].hoja_ruta,
            dominio: seleccionado.viajes[f].dominio
        }));
    }

    return {
        encontrado: true,
        nombre: seleccionado.nom,
        dni: seleccionado.dni,
        servicio: seleccionado.srv_chofer,
        foto: seleccionado.foto || null,
        contacto: seleccionado.contacto || { telefono: 'No registrado', email: 'No registrado', legajo: 'S/D' },
        ut_asignada: seleccionado.ut ? {
            n_ute: seleccionado.ut.n_ute || '',
            tractor: seleccionado.ut.tractor || null,
            semi: seleccionado.ut.semi || null,
            cisternado: seleccionado.ut.cisternado || '',
            srv: seleccionado.ut.srv || ''
        } : null,
        documentos: {
            vencimiento_licencia: seleccionado.documentos?.licencia || 'S/D',
            vencimiento_medico: seleccionado.documentos?.medico || 'S/D',
            apto_medico: seleccionado.documentos?.apto_medico || 'S/D',
            certificados: seleccionado.documentos?.certificados || 'S/D'
        },
        observaciones_recientes: (seleccionado.observaciones || []).slice(-3),
        viajes: resumenViajes
    };
}

/**
 * Herramienta 2: Consultar datos de una Unidad de Transporte (UT)
 */
async function consultarUt(args, cacheDatosGlobales) {
    const { query } = args;
    if (!query || !cacheDatosGlobales?.diagramas) {
        return { error: "No se proporcionó un número de UT o patente." };
    }

    const qRaw = String(query).trim().toUpperCase();
    const qSinCeros = qRaw.replace(/^0+/, '');
    const qClean = qRaw.replace(/\s+/g, '');

    const utMap = cacheDatosGlobales.diagramas.utMap || {};
    const utList = cacheDatosGlobales.diagramas.ut || [];

    // 1. Búsqueda O(1) directa por N° UTE
    let ut = utMap[qRaw] || utMap[qSinCeros];

    // 2. Búsqueda lineal por patente de tractor o semi
    if (!ut) {
        ut = utList.find(u => {
            if (u.n_ute && (u.n_ute === qRaw || u.n_ute.replace(/^0+/, '') === qSinCeros)) return true;
            if (u.tractor?.patente && u.tractor.patente.replace(/\s+/g, '') === qClean) return true;
            if (u.semi?.patente && u.semi.patente.replace(/\s+/g, '') === qClean) return true;
            return false;
        });
    }

    if (!ut) {
        return { mensaje: `No se encontró ninguna UT o patente que coincida con "${query}".` };
    }

    // Buscar novedades activas de esta UT
    const novedadesUt = (cacheDatosGlobales.novedades || []).filter(n => {
        const uStr = String(n.ut || '').trim();
        return uStr === ut.n_ute || uStr === ut.tractor?.patente || uStr === ut.semi?.patente;
    });

    return {
        encontrado: true,
        n_ute: ut.n_ute,
        servicio: ut.srv_ut || 'S/A',
        estado_operativo: ut.chofer_asignado ? 'ASIGNADO / OPERATIVO' : 'SIN ASIGNAR / DISPONIBLE',
        chofer_asignado: ut.chofer_asignado ? ut.chofer_asignado.nom : null,
        tractor: ut.tractor ? {
            patente: ut.tractor.patente,
            marca: ut.tractor.marca || '',
            vencimientos: ut.tractor.vencimientos || null
        } : null,
        semi: ut.semi ? {
            patente: ut.semi.patente,
            marca: ut.semi.marca || '',
            cisternado: ut.semi.cisternado || '',
            vencimientos: ut.semi.vencimientos || null
        } : null,
        novedades_activas: novedadesUt.map(n => ({
            fecha: n.fecha,
            tipo: n.tipo || 'Novedad',
            descripcion: n.descripcion || '',
            estado: n.resuelto ? 'RESUELTO' : 'PENDIENTE',
            chofer: n.chofer || ''
        }))
    };
}

/**
 * Herramienta 3: Resumen de Flota en vivo
 */
async function resumenFlota(args, cacheDatosGlobales) {
    const { servicio } = args || {};
    const utList = cacheDatosGlobales?.diagramas?.ut || [];

    if (utList.length === 0) {
        return { error: "No hay unidades cargadas en la memoria RAM." };
    }

    let filtradas = utList;
    if (servicio) {
        const srvNorm = limpiarTexto(servicio);
        filtradas = utList.filter(u => limpiarTexto(u.srv_ut).includes(srvNorm));
    }

    let total = filtradas.length;
    let conChofer = 0;
    let sinChofer = 0;
    let serviciosMap = {};

    filtradas.forEach(u => {
        if (u.chofer_asignado) conChofer++;
        else sinChofer++;

        const srv = (u.srv_ut || 'SIN_SERVICIO').toUpperCase().trim();
        if (!serviciosMap[srv]) serviciosMap[srv] = { total: 0, conChofer: 0, sinChofer: 0 };
        serviciosMap[srv].total++;
        if (u.chofer_asignado) serviciosMap[srv].conChofer++;
        else serviciosMap[srv].sinChofer++;
    });

    const novedadesPendientes = (cacheDatosGlobales.novedades || []).filter(n => !n.resuelto).length;

    return {
        filtro_servicio: servicio || 'TODOS',
        total_unidades: total,
        operativas_con_chofer: conChofer,
        paradas_sin_chofer: sinChofer,
        novedades_pendientes_flota: novedadesPendientes,
        desglose_por_servicio: serviciosMap
    };
}

/**
 * Herramienta 4: Consultar Novedades
 */
async function consultarNovedades(args, cacheDatosGlobales) {
    const { filtro, solo_pendientes = true } = args || {};
    let novedades = cacheDatosGlobales?.novedades || [];

    if (solo_pendientes) {
        novedades = novedades.filter(n => !n.resuelto);
    }

    if (filtro) {
        const f = limpiarTexto(filtro);
        novedades = novedades.filter(n => {
            return limpiarTexto(n.chofer).includes(f) ||
                   limpiarTexto(n.ut).includes(f) ||
                   limpiarTexto(n.descripcion).includes(f) ||
                   limpiarTexto(n.tipo).includes(f);
        });
    }

    return {
        total_encontradas: novedades.length,
        novedades: novedades.slice(0, 15).map(n => ({
            id: n.id,
            fecha: n.fecha,
            chofer: n.chofer,
            ut: n.ut,
            descripcion: n.descripcion,
            estado: n.resuelto ? 'RESUELTO' : 'PENDIENTE',
            prioridad: n.prioridad || 'NORMAL'
        }))
    };
}

/**
 * Herramienta 5: Consultar Asistencia / Diagrama Mensual
 */
async function consultarAsistencia(args, cacheDatosGlobales) {
    const { chofer, mes } = args;
    if (!chofer || !cacheDatosGlobales?.diagramas?.diagramas) {
        return { error: "Falta especificar el chofer o la base no está lista." };
    }

    const q = limpiarTexto(chofer);
    const cObj = cacheDatosGlobales.diagramas.diagramas.find(c => limpiarTexto(c.nom).includes(q));

    if (!cObj) {
        return { mensaje: `No se encontró al chofer "${chofer}".` };
    }

    if (!cObj.dias || typeof cObj.dias !== 'object') {
        return { mensaje: `No hay registro de asistencia cargado para ${cObj.nom}.` };
    }

    const hojasDisponibles = Object.keys(cObj.dias);
    let hojaTarget = null;

    if (mes) {
        const mNorm = limpiarTexto(mes);
        hojaTarget = hojasDisponibles.find(h => limpiarTexto(h).includes(mNorm));
    }

    // Por defecto tomar la hoja del mes actual (o la última disponible)
    if (!hojaTarget && hojasDisponibles.length > 0) {
        const ahora = new Date();
        const mActualAbrev = mesesAbrev[ahora.getMonth()].toLowerCase();
        hojaTarget = hojasDisponibles.find(h => h.toLowerCase().startsWith(mActualAbrev)) || hojasDisponibles[0];
    }

    if (!hojaTarget) {
        return { mensaje: "No se encontraron meses de diagrama disponibles." };
    }

    const tiraDias = (cObj.dias[hojaTarget] || '').split(',');
    let trabajados = 0;
    let francos = 0;
    let vacaciones = 0;
    let ausente = 0;
    let detalle = [];

    tiraDias.forEach((codigo, idx) => {
        const diaNum = idx + 1;
        const cod = String(codigo).trim().toUpperCase();
        if (['T', '1', 'D', 'N', 'M', 'T1', 'T2'].includes(cod)) trabajados++;
        else if (cod === 'F') francos++;
        else if (cod === 'V') vacaciones++;
        else if (cod !== '-' && cod !== '') ausente++;

        if (cod !== '-' && cod !== '') {
            detalle.push({ dia: diaNum, estado: cod });
        }
    });

    return {
        chofer: cObj.nom,
        mes: hojaTarget,
        resumen: {
            dias_trabajados: trabajados,
            francos: francos,
            vacaciones: vacaciones,
            otros: ausente
        },
        primeros_dias_activos: detalle.slice(0, 10)
    };
}

/**
 * Herramienta 6: Consultar Viajes (Híbrido: RAM para <= 12 meses, Cold Storage para > 12 meses)
 */
async function consultarViajes(args, cacheDatosGlobales) {
    const { chofer, desde, hasta } = args;
    if (!chofer) return { error: "Falta especificar el chofer para la consulta de viajes." };

    const q = limpiarTexto(chofer);
    const nuevaSeccionViajes = cacheDatosGlobales?.diagramas?.nuevaSeccionViajes || {};

    // Buscar en RAM
    let nBuscado = Object.keys(nuevaSeccionViajes).find(k => limpiarTexto(k).includes(q));

    if (nBuscado) {
        const viajesRam = nuevaSeccionViajes[nBuscado] || {};
        const fechas = Object.keys(viajesRam);

        let filtrados = {};
        for (let f of fechas) {
            if ((!desde || f >= desde) && (!hasta || f <= hasta)) {
                filtrados[f] = viajesRam[f];
            }
        }

        const keysFiltradas = Object.keys(filtrados);
        if (keysFiltradas.length > 0) {
            let totalKm = keysFiltradas.reduce((acc, k) => acc + (filtrados[k].km || 0), 0);
            return {
                fuente: "RAM (Tiempo real)",
                chofer: nBuscado.toUpperCase(),
                total_viajes: keysFiltradas.length,
                total_km: totalKm,
                detalle_reciente: keysFiltradas.sort().reverse().slice(0, 10).map(f => ({
                    fecha: f,
                    km: filtrados[f].km,
                    campo: filtrados[f].campo,
                    hoja_ruta: filtrados[f].hoja_ruta,
                    dominio: filtrados[f].dominio
                }))
            };
        }
    }

    // Si no está en RAM o se pidieron fechas más antiguas, acudir a Cold Storage
    try {
        // 🌟 1. Intentar consultar el microservicio exclusivo de KM
        if (isMicroservicioActivo()) {
            try {
                const histMicro = await obtenerHistorialMicroservicio(chofer, desde, hasta);
                if (histMicro && histMicro.success && histMicro.data) {
                    const keysCold = Object.keys(histMicro.data);
                    let totalKm = keysCold.reduce((acc, k) => acc + (histMicro.data[k].km || 0), 0);
                    return {
                        fuente: "MICROSERVICIO_KM (Histórico)",
                        chofer: chofer.toUpperCase(),
                        total_viajes: keysCold.length,
                        total_km: totalKm,
                        detalle_reciente: keysCold.sort().reverse().slice(0, 10).map(f => ({
                            fecha: f,
                            km: histMicro.data[f].km,
                            campo: histMicro.data[f].campo,
                            hoja_ruta: histMicro.data[f].hoja_ruta,
                            dominio: histMicro.data[f].dominio
                        }))
                    };
                }
            } catch (eMicro) {
                console.warn("⚠️ [Bot] Error consultando al microservicio KM:", eMicro.message);
            }
        }

        // 🔄 2. Fallback de respaldo directo en Google Sheets
        const rows = await fetchRango(ID_SHEET_KILOMETROS, "'KM'!A2:T");
        const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;
        let resultado = {};

        rows.forEach(row => {
            let fRaw = row[1], nRaw = row[2]; if (!fRaw || !nRaw) return;
            if (!limpiarTexto(nRaw).includes(q)) return;

            let dObj, parts = String(fRaw).split(' ')[0].split(/[\/\-]/);
            if (parts.length >= 3) {
                let aa = parts[2].length === 2 ? "20" + parts[2] : parts[2];
                dObj = new Date(aa, parseInt(parts[1], 10) - 1, parts[0]);
            } else {
                dObj = new Date(fRaw);
            }
            if (isNaN(dObj.getTime())) return;
            let isoDate = dObj.toISOString().split('T')[0];

            if ((!desde || isoDate >= desde) && (!hasta || isoDate <= hasta)) {
                let km = parseNum(row[16]) > 0 ? parseNum(row[16]) : parseNum(row[8]);
                let campo = parseNum(row[5]);
                let hojaStr = String(row[19] || "").trim();
                if (!resultado[isoDate]) resultado[isoDate] = { dominio: String(row[0] || '').trim(), km: 0, campo: 0, hoja_ruta: [] };
                resultado[isoDate].km += km;
                resultado[isoDate].campo += campo;
                if (hojaStr) {
                    hojaStr.split(',').map(s => s.trim()).filter(Boolean).forEach(h => {
                        if (!resultado[isoDate].hoja_ruta.includes(h)) resultado[isoDate].hoja_ruta.push(h);
                    });
                }
            }
        });

        const keysCold = Object.keys(resultado);
        let totalKm = keysCold.reduce((acc, k) => acc + (resultado[k].km || 0), 0);

        return {
            fuente: "COLD_STORAGE (Archivo Histórico Sheets)",
            chofer: chofer.toUpperCase(),
            total_viajes: keysCold.length,
            total_km: totalKm,
            detalle_reciente: keysCold.sort().reverse().slice(0, 10).map(f => ({
                fecha: f,
                km: resultado[f].km,
                campo: resultado[f].campo,
                hoja_ruta: resultado[f].hoja_ruta,
                dominio: resultado[f].dominio
            }))
        };
    } catch (e) {
        return { error: `Error consultando Cold Storage: ${e.message}` };
    }
}

/**
 * Declaraciones de herramientas para el SDK de Gemini (@google/genai)
 */
const functionDeclarations = [
    {
        name: "consultar_chofer",
        description: "Busca información completa de un chofer por nombre, apellido o DNI. Retorna datos de contacto (teléfono, email, legajo), UT y camión asignado hoy, vencimientos de carnet/médico/apto YPF, observaciones y viajes recientes.",
        parameters: {
            type: "OBJECT",
            properties: {
                query: {
                    type: "STRING",
                    description: "Nombre, apellido o DNI del chofer a buscar (ej: 'Acuña', 'Jorge', '35123456')."
                }
            },
            required: ["query"]
        }
    },
    {
        name: "consultar_ut",
        description: "Busca una Unidad de Transporte (UT) por su número de UTE, patente del tractor o patente del semirremolque. Retorna patente, marcas, cisternado, vencimientos (VTV, MAS, etc.), estado operativo y chofer asignado hoy.",
        parameters: {
            type: "OBJECT",
            properties: {
                query: {
                    type: "STRING",
                    description: "Número de UT (ej: '291', '5') o patente de tractor o semi (ej: 'AF123CD')."
                }
            },
            required: ["query"]
        }
    },
    {
        name: "resumen_flota",
        description: "Obtiene estadísticas y métricas en tiempo real de la flota: total de unidades, operativas con chofer asignado, unidades sin asignar, y desglose por servicio (LIVIANO, METANOL, CAMPO, etc.).",
        parameters: {
            type: "OBJECT",
            properties: {
                servicio: {
                    type: "STRING",
                    description: "Filtro opcional por servicio específico (ej: 'LIVIANO', 'METANOL', 'CAMPO', 'CHASIS'). Dejar vacío para toda la flota."
                }
            }
        }
    },
    {
        name: "consultar_novedades",
        description: "Consulta las novedades operativas activas y recientes registradas en la flota (problemas mecánicos, talleres, incidentes, etc.).",
        parameters: {
            type: "OBJECT",
            properties: {
                filtro: {
                    type: "STRING",
                    description: "Texto opcional para filtrar por chofer, UT, tipo o descripción."
                },
                solo_pendientes: {
                    type: "BOOLEAN",
                    description: "Si es true solo retorna novedades no resueltas. Por defecto true."
                }
            }
        }
    },
    {
        name: "consultar_asistencia",
        description: "Consulta los turnos, francos, vacaciones o días trabajados de un chofer en un mes determinado dentro del diagrama de asistencia.",
        parameters: {
            type: "OBJECT",
            properties: {
                chofer: {
                    type: "STRING",
                    description: "Nombre o apellido del chofer."
                },
                mes: {
                    type: "STRING",
                    description: "Mes a consultar (ej: 'mar-26', 'febrero', 'marzo'). Si se omite, consulta el mes actual."
                }
            },
            required: ["chofer"]
        }
    },
    {
        name: "consultar_viajes",
        description: "Consulta los viajes, kilómetros y hojas de ruta de un chofer en un rango de fechas. Utiliza la memoria RAM (<= 12 meses) o el almacenamiento histórico Cold Storage (> 12 meses).",
        parameters: {
            type: "OBJECT",
            properties: {
                chofer: {
                    type: "STRING",
                    description: "Nombre o apellido del chofer."
                },
                desde: {
                    type: "STRING",
                    description: "Fecha de inicio en formato 'YYYY-MM-DD'."
                },
                hasta: {
                    type: "STRING",
                    description: "Fecha de fin en formato 'YYYY-MM-DD'."
                }
            },
            required: ["chofer"]
        }
    }
];

// Mapa de ejecución directa de funciones
const toolsMap = {
    consultar_chofer: consultarChofer,
    consultar_ut: consultarUt,
    resumen_flota: resumenFlota,
    consultar_novedades: consultarNovedades,
    consultar_asistencia: consultarAsistencia,
    consultar_viajes: consultarViajes
};

module.exports = {
    functionDeclarations,
    toolsMap,
    consultarChofer,
    consultarUt,
    resumenFlota,
    consultarNovedades,
    consultarAsistencia,
    consultarViajes
};
