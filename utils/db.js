// ==============================================================
// 🐘 CLIENTE POSTGRESQL (pg / node-postgres) — Optimizado para bajo consumo de RAM
// ==============================================================

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const isConfigured = Boolean(DATABASE_URL);

// Configuración de límites estrictos de memoria para no exceder los límites de hosting (ej. Render 512 MB)
const poolConfig = {
    connectionString: DATABASE_URL,
    
    // ⚡ 1. Limitar concurrencia del pool
    // En entornos con 512 MB de RAM, 3 a 5 conexiones son suficientes y previenen spikes de memoria.
    max: parseInt(process.env.PG_MAX_CONNECTIONS || '5', 10),

    // ⚡ 2. Liberar conexiones inactivas rápidamente (10 segundos)
    idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT || '10000', 10),

    // ⚡ 3. Timeout corto de conexión para fallar rápido en cortes de red
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_TIMEOUT || '5000', 10),

    // ⚡ 4. Reciclar conexiones periódicamente para forzar la recolección de basura del GC
    maxUses: parseInt(process.env.PG_MAX_USES || '7500', 10),

    // SSL seguro para Supabase / Render / Neon / AWS RDS
    ssl: (process.env.NODE_ENV === 'production' || (DATABASE_URL && !DATABASE_URL.includes('localhost') && !DATABASE_URL.includes('127.0.0.1')))
        ? { rejectUnauthorized: false }
        : false
};

let pool = null;

if (isConfigured) {
    try {
        pool = new Pool(poolConfig);

        pool.on('error', (err) => {
            console.error('⚠️ [PostgreSQL] Error en cliente inactivo del pool:', err.message);
        });
    } catch (e) {
        console.error('❌ [PostgreSQL] Error inicializando el Pool:', e.message);
    }
} else {
    console.warn('ℹ️ [PostgreSQL] DATABASE_URL no configurada. Las consultas a Postgres usarán fallback.');
}

/**
 * Ejecuta una consulta SQL reservando y liberando automáticamente la conexión.
 * Ideal para minimizar el tiempo de conexión y evitar fugas de RAM.
 */
async function query(text, params) {
    if (!pool) {
        throw new Error('PostgreSQL no está configurado (DATABASE_URL ausente)');
    }
    const start = Date.now();
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    return { ...res, duration };
}

/**
 * Obtiene un cliente dedicado para transacciones complejas.
 * ⚠️ IMPORTANTE: SIEMPRE liberar el cliente con client.release() en un bloque finally.
 */
async function getClient() {
    if (!pool) {
        throw new Error('PostgreSQL no está configurado (DATABASE_URL ausente)');
    }
    return await pool.connect();
}

/**
 * Chequeo de salud y latencia
 */
async function checkHealth() {
    if (!pool) {
        return { ok: false, error: 'DATABASE_URL no configurada' };
    }
    const start = Date.now();
    try {
        const res = await pool.query('SELECT NOW() as now, current_database() as db');
        return {
            ok: true,
            latencyMs: Date.now() - start,
            database: res.rows[0]?.db,
            serverTime: res.rows[0]?.now
        };
    } catch (err) {
        return {
            ok: false,
            latencyMs: Date.now() - start,
            error: err.message
        };
    }
}

/**
 * Retorna las métricas del pool y de memoria de Node.js
 */
function getPoolMetrics() {
    const mem = process.memoryUsage();
    return {
        isConfigured,
        poolConfig: {
            max: poolConfig.max,
            idleTimeoutMillis: poolConfig.idleTimeoutMillis,
            connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
            maxUses: poolConfig.maxUses,
            ssl: Boolean(poolConfig.ssl)
        },
        poolStatus: pool ? {
            totalCount: pool.totalCount,
            idleCount: pool.idleCount,
            waitingCount: pool.waitingCount
        } : null,
        memoryUsage: {
            rssMB: +(mem.rss / 1024 / 1024).toFixed(2),
            heapTotalMB: +(mem.heapTotal / 1024 / 1024).toFixed(2),
            heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(2),
            externalMB: +(mem.external / 1024 / 1024).toFixed(2)
        }
    };
}

module.exports = {
    pool,
    query,
    getClient,
    checkHealth,
    getPoolMetrics,
    isConfigured: () => isConfigured
};
