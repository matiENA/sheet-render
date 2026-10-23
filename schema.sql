-- ==============================================================================
-- 🚀 ESQUEMA UNIFICADO DE BASE DE DATOS (SUPABASE)
-- Proyecto: https://rsvajuxihvmpmrmlcbul.supabase.co
-- Arquitectura Relacional Organizada de Raíz por Servicios (Unidades y Choferes)
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==============================================================================
-- 1. TABLA: servicios_unidades (Catálogo de Servicios de Flota)
-- Origen: Planilla Movimientos (1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.servicios_unidades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    denominacion TEXT NOT NULL UNIQUE,
    descripcion TEXT,
    spreadsheet_id TEXT DEFAULT '1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8',
    activo BOOLEAN DEFAULT TRUE,
    creado_el TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_servicios_unidades_denominacion ON public.servicios_unidades(denominacion);

-- ==============================================================================
-- 2. TABLA: servicios_choferes (Catálogo de Cuentas/Servicios de Choferes)
-- Origen: Planilla Diagramas (1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU)
-- Relación opcional con servicios_unidades para mapeo/equivalencias entre dominios
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.servicios_choferes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    denominacion TEXT NOT NULL UNIQUE,
    servicio_unidad_id UUID REFERENCES public.servicios_unidades(id) ON DELETE SET NULL,
    descripcion TEXT,
    spreadsheet_id TEXT DEFAULT '1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU',
    activo BOOLEAN DEFAULT TRUE,
    creado_el TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_servicios_choferes_denominacion ON public.servicios_choferes(denominacion);
CREATE INDEX IF NOT EXISTS idx_servicios_choferes_serv_unidad ON public.servicios_choferes(servicio_unidad_id);

-- ==============================================================================
-- 3. TABLA: tractores (Catálogo Canónico de Activos Tractores)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.tractores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    servicio_id UUID REFERENCES public.servicios_unidades(id) ON DELETE SET NULL,
    patente TEXT NOT NULL UNIQUE,
    n_interno TEXT,
    marca TEXT,
    modelo TEXT,
    vtv DATE,
    mas DATE,
    estado TEXT DEFAULT 'disponible' CHECK (estado IN ('disponible', 'circulando', 'taller', 'mantenimiento', 'baja')),
    actualizado_el TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tractores_patente ON public.tractores(patente);
CREATE INDEX IF NOT EXISTS idx_tractores_servicio ON public.tractores(servicio_id);
CREATE INDEX IF NOT EXISTS idx_tractores_estado ON public.tractores(estado);

-- ==============================================================================
-- 4. TABLA: semis (Catálogo Canónico de Semirremolques / Cisternas)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.semis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    servicio_id UUID REFERENCES public.servicios_unidades(id) ON DELETE SET NULL,
    patente TEXT NOT NULL UNIQUE,
    n_interno TEXT,
    marca TEXT,
    cisternado TEXT,
    esp_es TEXT,
    vi TEXT,
    ve TEXT,
    vtv DATE,
    mas DATE,
    estado TEXT DEFAULT 'disponible' CHECK (estado IN ('disponible', 'circulando', 'taller', 'mantenimiento', 'baja')),
    actualizado_el TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_semis_patente ON public.semis(patente);
CREATE INDEX IF NOT EXISTS idx_semis_servicio ON public.semis(servicio_id);
CREATE INDEX IF NOT EXISTS idx_semis_estado ON public.semis(estado);

-- ==============================================================================
-- 5. TABLA: unidades (Formaciones Operativas / Acoples de Flota - Solo IDs)
-- Vincula n_ute con un tractor y un semi bajo un servicio_unidad
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.unidades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    servicio_id UUID REFERENCES public.servicios_unidades(id) ON DELETE SET NULL,
    n_ute TEXT,
    tractor_id UUID REFERENCES public.tractores(id) ON DELETE SET NULL,
    semi_id UUID REFERENCES public.semis(id) ON DELETE SET NULL,
    fecha_acople TIMESTAMPTZ DEFAULT NOW(),
    estado TEXT DEFAULT 'disponible' CHECK (estado IN ('disponible', 'circulando', 'taller', 'mantenimiento', 'baja'))
);

CREATE INDEX IF NOT EXISTS idx_unidades_servicio_id ON public.unidades(servicio_id);
CREATE INDEX IF NOT EXISTS idx_unidades_tractor_id ON public.unidades(tractor_id);
CREATE INDEX IF NOT EXISTS idx_unidades_semi_id ON public.unidades(semi_id);
CREATE INDEX IF NOT EXISTS idx_unidades_n_ute ON public.unidades(n_ute);
CREATE INDEX IF NOT EXISTS idx_unidades_estado ON public.unidades(estado);

-- ==============================================================================
-- 6. TABLA: choferes (Catálogo Maestro de Choferes)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.choferes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    servicio_id UUID REFERENCES public.servicios_choferes(id) ON DELETE SET NULL,
    nombre TEXT NOT NULL,
    dni TEXT,
    legajo TEXT,
    telefono TEXT,
    c_servicio TEXT,
    diagrama_tipo TEXT,
    estado TEXT DEFAULT 'inactivo' CHECK (estado IN ('inactivo', 'circulando', 'franco', 'licencia', 'baja')),
    unidad_id UUID REFERENCES public.unidades(id) ON DELETE SET NULL,
    diagrama_json JSONB,
    contabilizador JSONB,
    actualizado_el TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_choferes_servicio_id ON public.choferes(servicio_id);
CREATE INDEX IF NOT EXISTS idx_choferes_nombre ON public.choferes(nombre);
CREATE INDEX IF NOT EXISTS idx_choferes_legajo ON public.choferes(legajo);
CREATE INDEX IF NOT EXISTS idx_choferes_estado ON public.choferes(estado);

-- ==============================================================================
-- 7. TABLA: movimientos (Pareo activo diario Unidad <-> Chofer)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.movimientos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_unidad UUID REFERENCES public.unidades(id) ON DELETE CASCADE,
    id_chofer UUID REFERENCES public.choferes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mov_id_unidad ON public.movimientos(id_unidad);
CREATE INDEX IF NOT EXISTS idx_mov_id_chofer ON public.movimientos(id_chofer);

-- ==============================================================================
-- 8. TABLA: usuarios_auth (Acceso a Dashboards)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.usuarios_auth (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    rol TEXT DEFAULT 'operador',
    creado_el TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- 9. TABLA: diagramas (Histórico mensual completo para 'Resto Consulta')
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.diagramas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chofer_id UUID REFERENCES public.choferes(id) ON DELETE CASCADE,
    chofer_nombre TEXT NOT NULL,
    legajo TEXT,
    servicio TEXT,
    diagrama_tipo TEXT,
    mes_tab TEXT NOT NULL,          -- ej: 'Sep-26'
    anio INTEGER NOT NULL,          -- ej: 2026
    mes_numero INTEGER NOT NULL,    -- ej: 9
    dias JSONB NOT NULL,            -- ej: {"2026-09-01": "12", "2026-09-02": "F", ...}
    tira_dias TEXT,                 -- ej: "12,F,F+1,..."
    contabilizador JSONB NOT NULL,  -- ej: {"trabajados": 22, "francos": 6, "vacaciones": 0, "ausencias": 2, "desglose": {...}}
    actualizado_el TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_diagrama_chofer_mes UNIQUE (chofer_nombre, mes_tab)
);

CREATE INDEX IF NOT EXISTS idx_diagramas_chofer ON public.diagramas(chofer_nombre);
CREATE INDEX IF NOT EXISTS idx_diagramas_mes ON public.diagramas(mes_tab);
CREATE INDEX IF NOT EXISTS idx_diagramas_anio_mes ON public.diagramas(anio, mes_numero);
CREATE INDEX IF NOT EXISTS idx_diagramas_chofer_id ON public.diagramas(chofer_id);

-- ==============================================================================
-- 10. TABLA: movimientos_km (Registro de Kilómetros)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.movimientos_km (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fecha DATE NOT NULL,
    id_unidad UUID REFERENCES public.unidades(id) ON DELETE SET NULL,
    id_chofer UUID REFERENCES public.choferes(id) ON DELETE SET NULL,
    dominio TEXT,
    chofer_nombre TEXT,
    km_totales NUMERIC(10,2) DEFAULT 0,
    hoja_ruta TEXT,
    creado_el TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mov_km_fecha ON public.movimientos_km(fecha);
CREATE INDEX IF NOT EXISTS idx_mov_km_id_unidad ON public.movimientos_km(id_unidad);
CREATE INDEX IF NOT EXISTS idx_mov_km_id_chofer ON public.movimientos_km(id_chofer);
CREATE INDEX IF NOT EXISTS idx_mov_km_dominio ON public.movimientos_km(dominio);
CREATE INDEX IF NOT EXISTS idx_mov_km_chofer_nombre ON public.movimientos_km(chofer_nombre);

-- ==============================================================================
-- 10.1 VISTAS OPTIMIZADAS PARA CALENDARIO / DIAGRAMA (view_calendario_km)
-- ==============================================================================
CREATE OR REPLACE VIEW public.view_calendario_km AS
SELECT 
    m.fecha,
    m.id_chofer,
    c.nombre AS chofer_nombre,
    c.legajo,
    m.id_unidad,
    u.n_ute,
    m.dominio,
    ROUND(SUM(m.km_totales)::numeric, 2) AS km,
    COUNT(*)::int AS cant_viajes,
    ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.hoja_ruta), NULL) AS hoja_ruta
FROM public.movimientos_km m
LEFT JOIN public.choferes c ON m.id_chofer = c.id
LEFT JOIN public.unidades u ON m.id_unidad = u.id
GROUP BY m.fecha, m.id_chofer, c.nombre, c.legajo, m.id_unidad, u.n_ute, m.dominio;

CREATE OR REPLACE VIEW public.view_calendario_mes_km AS
SELECT 
    TO_CHAR(m.fecha, 'YYYY-MM') AS mes,
    m.id_chofer,
    c.nombre AS chofer_nombre,
    c.legajo,
    ROUND(SUM(m.km_dia)::numeric, 2) AS total_km_mes,
    COUNT(m.fecha)::int AS dias_activos,
    jsonb_object_agg(
        TO_CHAR(m.fecha, 'YYYY-MM-DD'),
        jsonb_build_object(
            'id_unidad', m.id_unidad,
            'dominio', m.dominio,
            'n_ute', m.n_ute,
            'km', m.km_dia,
            'hoja_ruta', m.hoja_ruta
        )
    ) AS viajes_dia
FROM (
    SELECT 
        fecha,
        id_chofer,
        id_unidad,
        dominio,
        COALESCE(u.n_ute, '') AS n_ute,
        ROUND(SUM(km_totales)::numeric, 2) AS km_dia,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT hoja_ruta), NULL) AS hoja_ruta
    FROM public.movimientos_km m_inner
    LEFT JOIN public.unidades u ON m_inner.id_unidad = u.id
    GROUP BY fecha, id_chofer, id_unidad, dominio, u.n_ute
) m
JOIN public.choferes c ON m.id_chofer = c.id
GROUP BY TO_CHAR(m.fecha, 'YYYY-MM'), m.id_chofer, c.nombre, c.legajo;

-- ==============================================================================
-- 11. TABLA: chofer_documentacion (Legajos, Vencimientos y Salud)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.chofer_documentacion (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chofer_id UUID REFERENCES public.choferes(id) ON DELETE CASCADE UNIQUE,
    drv_codigo TEXT,
    cuil TEXT,
    dni TEXT,
    telefono TEXT,
    email TEXT,
    empresa TEXT,
    area TEXT,
    domicilio TEXT,
    localidad TEXT,
    telefono_emergencia TEXT,
    fecha_alta DATE,
    estudios_nivel TEXT,
    experiencia_anios TEXT,
    fecha_nacimiento DATE,
    edad NUMERIC(5,2),
    venc_licencia_nacional DATE,
    venc_psicofisico DATE,
    venc_cargas_peligrosas DATE,
    venc_periodico DATE,
    venc_curso_shell DATE,
    venc_manejo_def DATE,
    curso_pae TEXT,
    apto_medico_venc DATE,
    apto_medico_estado TEXT,
    avalado_contratos TEXT,
    vacuna_antitetanica TEXT,
    metabolitos_7 TEXT,
    vacuna_covid TEXT,
    dosis_covid TEXT,
    obs_documentacion TEXT,
    actualizado_el TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chofer_doc_chofer_id ON public.chofer_documentacion(chofer_id);
CREATE INDEX IF NOT EXISTS idx_chofer_doc_cuil ON public.chofer_documentacion(cuil);
CREATE INDEX IF NOT EXISTS idx_chofer_doc_dni ON public.chofer_documentacion(dni);

-- ==============================================================================
-- 12. TABLA: chofer_observaciones (Historial de Novedades y Sanciones)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.chofer_observaciones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chofer_id UUID REFERENCES public.choferes(id) ON DELETE CASCADE,
    fecha DATE,
    unidad_dominio TEXT,
    evento TEXT,
    obs_evento TEXT,
    estado TEXT,
    obs_estado TEXT,
    admin_carga TEXT,
    creado_el TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chofer_obs_chofer_id ON public.chofer_observaciones(chofer_id);
CREATE INDEX IF NOT EXISTS idx_chofer_obs_fecha ON public.chofer_observaciones(fecha);

-- ==============================================================================
-- 13. POLÍTICAS DE SEGURIDAD (RLS)
-- ==============================================================================
ALTER TABLE public.servicios_unidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.servicios_choferes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tractores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.semis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.choferes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuarios_auth ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diagramas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos_km ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chofer_documentacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chofer_observaciones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Permitir todo en servicios_unidades" ON public.servicios_unidades;
CREATE POLICY "Permitir todo en servicios_unidades" ON public.servicios_unidades FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en servicios_choferes" ON public.servicios_choferes;
CREATE POLICY "Permitir todo en servicios_choferes" ON public.servicios_choferes FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en tractores" ON public.tractores;
CREATE POLICY "Permitir todo en tractores" ON public.tractores FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en semis" ON public.semis;
CREATE POLICY "Permitir todo en semis" ON public.semis FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en unidades" ON public.unidades;
CREATE POLICY "Permitir todo en unidades" ON public.unidades FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en choferes" ON public.choferes;
CREATE POLICY "Permitir todo en choferes" ON public.choferes FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en movimientos" ON public.movimientos;
CREATE POLICY "Permitir todo en movimientos" ON public.movimientos FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en usuarios_auth" ON public.usuarios_auth;
CREATE POLICY "Permitir todo en usuarios_auth" ON public.usuarios_auth FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en diagramas" ON public.diagramas;
CREATE POLICY "Permitir todo en diagramas" ON public.diagramas FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en movimientos_km" ON public.movimientos_km;
CREATE POLICY "Permitir todo en movimientos_km" ON public.movimientos_km FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en chofer_documentacion" ON public.chofer_documentacion;
CREATE POLICY "Permitir todo en chofer_documentacion" ON public.chofer_documentacion FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en chofer_observaciones" ON public.chofer_observaciones;
CREATE POLICY "Permitir todo en chofer_observaciones" ON public.chofer_observaciones FOR ALL USING (true) WITH CHECK (true);
