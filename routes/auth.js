const express = require('express');
const { supabase } = require('../utils/shared');
const db = require('../utils/db');

module.exports = function createAuthRouter() {
    const router = express.Router();

    router.post('/login', async (req, res) => {
        try {
            const { usuario, password } = req.body || {};
            if (!usuario || !password) {
                return res.json({ success: false, error: "Usuario y contraseña requeridos" });
            }

            const uClean = String(usuario).trim().toLowerCase();
            const pClean = String(password).trim();

            // 1. Validar con PostgreSQL (pg client - ultraligero en RAM y respuesta en milisegundos)
            if (db.isConfigured()) {
                try {
                    const { rows } = await db.query(
                        'SELECT id, usuario, rol FROM usuarios_auth WHERE LOWER(TRIM(usuario)) = LOWER(TRIM($1)) AND password = $2 LIMIT 1',
                        [usuario, password]
                    );
                    if (rows && rows.length > 0) {
                        const user = rows[0];
                        return res.json({ 
                            success: true, 
                            token: 'auth_' + user.id + '_' + Date.now(), 
                            usuario: String(user.usuario).toUpperCase(), 
                            rol: user.rol,
                            fuente: 'POSTGRES_PG'
                        });
                    }
                } catch (ePg) {
                    console.error("Error consultando usuarios_auth con pg client:", ePg.message);
                }
            }

            // 3. Fallback: Validar en Supabase REST Client
            try {
                const { data: user } = await supabase
                    .from('usuarios_auth')
                    .select('id, usuario, rol')
                    .eq('usuario', usuario)
                    .eq('password', password)
                    .single();
                    
                if (user) {
                    return res.json({ 
                        success: true, 
                        token: 'auth_' + user.id + '_' + Date.now(), 
                        usuario: String(user.usuario).toUpperCase(), 
                        rol: user.rol,
                        fuente: 'SUPABASE_REST'
                    });
                }
            } catch (eSupa) {
                console.error("Error consultando usuarios_auth en Supabase:", eSupa);
            }

            return res.json({ success: false, error: "Usuario o contraseña incorrectos" });
        } catch (err) {
            console.error("Error en login de servidor:", err);
            return res.status(500).json({ success: false, error: "Error en login de servidor" });
        }
    });

    return router;
};
