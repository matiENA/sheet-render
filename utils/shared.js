// ==============================================================
// 🔧 UTILIDADES COMPARTIDAS — Módulo Central
// ==============================================================
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

// ==============================================================
// 📝 Funciones de normalización y fecha
// ==============================================================
const normalizar = (n) => {
    if (!n) return '';
    return String(n)
        .normalize('NFC')
        .replace(/__N_TILDE__/gi, 'ñ')
        .trim()
        .toLowerCase()
        .replace(/[áäàâ]/g, 'a')
        .replace(/[éëèê]/g, 'e')
        .replace(/[íïìî]/g, 'i')
        .replace(/[óöòô]/g, 'o')
        .replace(/[úüùû]/g, 'u')
        .replace(/\s+/g, ' ');
};

function getFechaArgentina() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utc - (3 * 3600000));
}

// ==============================================================
// 📅 Constantes de meses
// ==============================================================
const mesesAbrev = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const mesesLargo = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// ==============================================================
// 🔑 IDs de Google Spreadsheets
// ==============================================================
const ID_SPREADSHEET_MASTER = process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
const ID_SPREADSHEET_DIAGRAMAS = '1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU';
const ID_SHEET_OBSERVACIONES = '1VwCNK89ecaac7IDlMWWCLHRqZoch9HB6vop5AfQEaA0';
const ID_SHEET_APTOS_MEDICOS = '1oJmN8hurfHfNnGBYUFcBdlrIj2VUzeIyq0ZTWxTpYNI';
const ID_SHEET_KILOMETROS = '1Wr-_P4mDvldif_cAx08sp7yT8uTUrajI2HQAJF6tnGM';
const ID_SHEET_HABILITACIONES = '1hPDno09tMBtKh7aIdsvzEYcyOY7leYj2B6XnniD0aXg';
const ID_SHEET_DOCUMENTOS = '1pnYXKDSv70Vq78Rchxus5FHMKdgXdbfltVsEg6vArjo';
const ID_SHEET_MOVIMIENTOS = process.env.MES_MOVIMIENTOS_ID || '14Mb5rD853zxDkaLDS-IrW-OBDTDBjuJxn_3olXeWlkc';

// ==============================================================
// 🔐 Instancias de autenticación
// ==============================================================
const serviceAccountAuth = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) ? new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
}) : null;

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) 
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY) 
    : null;

// ==============================================================
// 📡 Helpers de Google Sheets (Opcionales si hay credenciales)
// ==============================================================
async function fetchRango(spreadsheetId, rango, reintentos = 3) {
    if (!serviceAccountAuth) return [];
    for (let i = 0; i < reintentos; i++) {
        try {
            return (await serviceAccountAuth.request({
                url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(rango)}`
            })).data.values || [];
        } catch (e) {
            if (e.response && e.response.status === 429) {
                await new Promise(resolve => setTimeout(resolve, (i + 1) * 1500));
            } else {
                return [];
            }
        }
    }
    return [];
}

async function getTabName(spreadsheetId, keyword, defaultName) {
    try {
        const resMeta = await serviceAccountAuth.request({
            url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`
        });
        const sheets = (resMeta.data.sheets || []).map(s => s.properties.title);
        if (!sheets || sheets.length === 0) return defaultName;

        let hoyAr = getFechaArgentina();
        let mesNombre = mesesLargo[hoyAr.getMonth()].toLowerCase();
        let mesAbrev = mesesAbrev[hoyAr.getMonth()].toLowerCase();
        const normKw = keyword.toLowerCase().replace(/\s+/g, '');

        // Prioridad 1: Pestaña del mes actual que contenga el keyword
        let foundCurrent = sheets.slice().reverse().find(s => {
            let low = s.toLowerCase();
            return (low.includes(mesNombre) || low.includes(mesAbrev)) && low.replace(/\s+/g, '').includes(normKw);
        });
        if (foundCurrent) return foundCurrent;

        // Prioridad 2: Última pestaña que contenga el keyword
        let foundLast = sheets.slice().reverse().find(s => s.toLowerCase().replace(/\s+/g, '').includes(normKw));
        if (foundLast) return foundLast;

        // Prioridad 3: Fallback para "mov"
        if (normKw.includes("mov")) {
            let foundMov = sheets.slice().reverse().find(s => s.toLowerCase().includes("mov"));
            if (foundMov) return foundMov;
        }

        return sheets[0] || defaultName;
    } catch (e) {
        return defaultName;
    }
}

// ==============================================================
// 📦 Exports
// ==============================================================
module.exports = {
    // Funciones
    normalizar,
    getFechaArgentina,
    fetchRango,
    getTabName,
    // Constantes de meses
    mesesAbrev,
    mesesLargo,
    // IDs de planillas
    ID_SPREADSHEET_MASTER,
    ID_SPREADSHEET_DIAGRAMAS,
    ID_SHEET_OBSERVACIONES,
    ID_SHEET_APTOS_MEDICOS,
    ID_SHEET_KILOMETROS,
    ID_SHEET_HABILITACIONES,
    ID_SHEET_DOCUMENTOS,
    ID_SHEET_MOVIMIENTOS,
    // Instancias de auth
    serviceAccountAuth,
    supabase
};
