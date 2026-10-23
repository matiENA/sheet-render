// ==============================================================
// 📡 CLIENTE DEL MICROSERVICIO DE KILÓMETROS
// Permite al backend principal consultar la partición de RAM externa
// ==============================================================

function getKmServiceUrl() {
    const url = process.env.KM_SERVICE_URL;
    return url ? url.replace(/\/$/, '') : null;
}

function isMicroservicioActivo() {
    return Boolean(getKmServiceUrl());
}

/**
 * Obtiene los viajes procesados de los últimos 12 meses desde el microservicio
 * Retorna { [choferNorm]: { [isoDate]: { dominio, km, campo, hoja_ruta } } } o null si falla
 */
async function obtenerViajesMicroservicio(timeoutMs = 8000) {
    const baseUrl = getKmServiceUrl();
    if (!baseUrl) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const url = `${baseUrl}/api/km/viajes`;
        console.log(`📡 [KM-Client] Solicitando partición de RAM a microservicio: ${url}...`);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) {
            console.warn(`⚠️ [KM-Client] Microservicio respondió con status ${res.status}`);
            return null;
        }

        const json = await res.json();
        if (json && json.success && json.viajes) {
            console.log(`✅ [KM-Client] ${json.totalViajesHot || 0} viajes recibidos de ${json.choferesCount || 0} choferes desde el microservicio.`);
            return json.viajes;
        }
        return null;
    } catch (e) {
        clearTimeout(timeout);
        console.warn(`⚠️ [KM-Client] No se pudo obtener datos del microservicio (${e.name === 'AbortError' ? 'Timeout' : e.message}).`);
        return null;
    }
}

/**
 * Consulta histórica de viajes sobre demanda (Cold Storage)
 */
async function obtenerHistorialMicroservicio(chofer, desde, hasta, timeoutMs = 8000) {
    const baseUrl = getKmServiceUrl();
    if (!baseUrl) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const params = new URLSearchParams({ chofer: chofer || '' });
        if (desde) params.append('desde', desde);
        if (hasta) params.append('hasta', hasta);

        const url = `${baseUrl}/api/km/historial?${params.toString()}`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) return null;
        const json = await res.json();
        if (json && json.success) {
            return {
                success: true,
                fuente: "MICROSERVICIO",
                data: json.data || {}
            };
        }
        return null;
    } catch (e) {
        clearTimeout(timeout);
        console.warn(`⚠️ [KM-Client] Error consultando historial en microservicio: ${e.message}`);
        return null;
    }
}

/**
 * Guarda hoja de ruta delegando la operación al microservicio
 */
async function guardarHojaRutaMicroservicio(payload, timeoutMs = 12000) {
    const baseUrl = getKmServiceUrl();
    if (!baseUrl) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const url = `${baseUrl}/api/km/hoja-ruta`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        clearTimeout(timeout);
        console.warn(`⚠️ [KM-Client] Error delegando hoja de ruta al microservicio: ${e.message}`);
        return null;
    }
}

/**
 * Chequea la salud y métricas del microservicio
 */
async function checkSaludMicroservicio(timeoutMs = 4000) {
    const baseUrl = getKmServiceUrl();
    if (!baseUrl) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) return await res.json();
        return null;
    } catch (e) {
        clearTimeout(timeout);
        return null;
    }
}

module.exports = {
    getKmServiceUrl,
    isMicroservicioActivo,
    obtenerViajesMicroservicio,
    obtenerHistorialMicroservicio,
    guardarHojaRutaMicroservicio,
    checkSaludMicroservicio
};
