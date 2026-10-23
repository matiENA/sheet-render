# 🚀 Sheet-Render Backend API — Servidor para Render (Supabase ➔ Front)

Servidor backend de alto rendimiento diseñado para desplegarse en **Render** (o cualquier entorno cloud / contenedor) como **Web Service**.

> **Misión:**  
> Servir como puente ultrarrápido y reactivo entre **Supabase (PostgreSQL)** y las aplicaciones frontend (**Dashboard de Diagramas**, **Dashboard de Flota**, **Sistema de Pañol**, etc.), manteniendo una caché en RAM de acceso sub-milimétrico (< 5ms) y canales WebSocket en tiempo real.
>
> **Aislamiento Total:**  
> Este backend **NO** realiza la extracción pesada de Google Sheets (tarea delegada al módulo `local_loader`). Opera directamente con las tablas estructuradas de Supabase, eliminando caídas por límites de memoria y timeouts en Render.

---

## 📐 Arquitectura de Alto Rendimiento

```mermaid
flowchart TD
    subgraph SUPABASE["Supabase PostgreSQL (Base de Datos Central)"]
        T1[("unidades")]
        T2[("choferes")]
        T3[("movimientos")]
        T4[("movimientos_km")]
        T5[("usuarios_auth")]
        T6[("chofer_observaciones")]
    end

    subgraph BACKEND["Backend en Render (Web Service Node.js)"]
        POOL["utils/db.js<br/>(Pool Nativo PostgreSQL 6543)"]
        BUILDER["cache/builder.js<br/>(Ensamblador de RAM + Dirty-Check)"]
        RAM[("⚡ HOT RAM CACHE<br/>• Tiempo de respuesta < 5ms<br/>• ETag 304 Not Modified<br/>• Supresión de Egress")]
        EXPRESS["Express API REST<br/>(/api/datos, /api/dash, /api/diagramas, /ram)"]
        SIO["Socket.IO Server<br/>(Broadcast de mutaciones)"]
    end

    subgraph FRONTENDS["Clientes Frontend (Render / Web)"]
        DASH["📊 Dashboard Operativo (dash)"]
        DIAG["📅 Dashboard de Diagramas (diagramasnode)"]
        PANOL["🔧 Pañol y Mantenimiento"]
    end

    SUPABASE --> POOL
    POOL --> BUILDER
    BUILDER --> RAM
    RAM --> EXPRESS
    RAM --> SIO
    EXPRESS --> FRONTENDS
    SIO --> FRONTENDS
```

---

## 📁 Estructura del Proyecto

```text
backend_render/
├── cache/
│   └── builder.js          # Gestor de RAM reactiva y dirty check con Supabase
├── routes/
│   ├── auth.js             # Autenticación de usuarios contra Supabase / Postgres
│   ├── dash.js             # Endpoints optimizados para el Dashboard de Flota
│   ├── diagramas.js        # Endpoints de diagramas, turnos y contabilizadores
│   ├── fotos.js            # Galería de fotos de choferes y unidades
│   ├── proxy.js            # Endpoints de compatibilidad y persistencia
│   └── bot.js              # Router para bot asistente
├── bot/                    # Motor del bot asistente
├── utils/
│   ├── db.js               # Conexión nativa a Postgres mediante pg.Pool
│   ├── kmClient.js         # Cliente para microservicio de kilómetros
│   └── shared.js           # Normalizadores, fechas y cliente Supabase
├── server.js               # Entrada principal (Express + Socket.io)
├── novedades.js            # Módulo de novedades operativas
├── webhook.js              # Receptor de webhooks para actualizaciones reactivas
├── schema.sql              # Esquema SQL canónico de tablas de Supabase
├── render.yaml             # Blueprint para despliegue automático en Render
├── package.json            # Dependencias del backend
├── .env.example            # Referencia de variables de entorno para Render
├── .env                        # Configuración para pruebas locales (Puerto 3005)
└── README.md               # Esta documentación
```

---

## ☁️ Guía de Despliegue en Render (Paso a Paso)

### Opción 1: Despliegue Mediante Blueprint (`render.yaml`)
1. Sube esta carpeta a tu repositorio de GitHub (o configura `Root Directory: backend_render` en tu monorepo).
2. En Render, selecciona **New > Blueprint**.
3. Selecciona tu repositorio. Render detectará el archivo [`render.yaml`](render.yaml) y configurará el servicio automáticamente.

---

### Opción 2: Configuración Manual como Web Service
1. En el Dashboard de Render, presiona **New + > Web Service**.
2. Conecta tu repositorio de GitHub.
3. Ajusta los siguientes parámetros:
   - **Name:** `fleet-backend-render` (o el nombre que elijas)
   - **Language / Runtime:** `Node`
   - **Region:** `Oregon (US West)` o la más cercana a tu base de datos de Supabase.
   - **Root Directory:** `backend_render` (si está dentro del repo `storage_ram_db`) o `./` (si subiste esta carpeta como repo independiente).
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** `Starter` o `Free`

4. En la sección **Environment Variables**, añade las siguientes variables:

| Variable | Valor / Ejemplo | Obligatorio | Descripción |
|---|---|:---:|---|
| `NODE_VERSION` | `20.x` | Sí | Versión de Node.js recomendada. |
| `SUPABASE_URL` | `https://rsvajuxihvmpmrmlcbul.supabase.co` | Sí | URL de tu proyecto en Supabase. |
| `SUPABASE_KEY` | `sb_publishable_...` o `service_role` | Sí | API Key de Supabase. |
| `DATABASE_URL` | `postgresql://postgres...:6543/postgres?pgbouncer=true` | Sí | Connection string del transaction pooler de Supabase (puerto 6543). |
| `KM_RAM_DIAS` | `60` | No | Días de historial de KM cargados en memoria (def: 60). |
| `KM_SERVICE_URL` | `https://km-extractor-service.onrender.com` | No | URL del microservicio de kilómetros. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `firebase-adminsdk...` | No | Opcional: Solo si se leen novedades desde Sheets. |
| `GOOGLE_PRIVATE_KEY` | `"-----BEGIN PRIVATE KEY-----\n..."` | No | Opcional: Solo si se leen novedades desde Sheets. |

> **Nota sobre el Puerto:**  
> Render asigna automáticamente el puerto a través de la variable `PORT` (usualmente `10000`). `server.js` detecta `process.env.PORT` dinámicamente.

---

## 🌐 Endpoints Principales de la API

### 1. Diagnóstico y Salud
| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/health` | Devuelve `200 OK` para health checks de Render y balanceadores. |
| `GET` | `/ram` | Métricas en tiempo real: conteo de choferes, unidades y viajes en RAM. |

### 2. Datos para el Front
| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/api/datos` | Datos globales de diagramas, unidades y vencimientos. Soporta **ETag / 304 Not Modified** para no gastar ancho de banda si no hay cambios. |
| `GET` | `/api/datos?include_km=true` | Incluye la sección completa de kilometraje si el front la solicita. |
| `GET` | `/api/viajes/historial` | Consulta bajo demanda de viajes históricos por chofer (`?chofer=...&desde=...&hasta=...`). |
| `GET` | `/api/km/resumen` | KPIs globales de flota (total km recorridos, total viajes, choferes). |

### 3. Autenticación y Módulos Específicos
| Método | Endpoint | Descripción |
|---|---|---|
| `POST` | `/api/auth/login` | Login validado contra la tabla `usuarios_auth` en PostgreSQL / Supabase. |
| `GET` | `/api/dash/flota` | Lista ligera de flota optimizada para el Dashboard Operativo. |
| `GET` | `/api/dash/ut` | Catálogo de unidades tractor-semi. |
| `GET` | `/api/dash/novedades` | Novedades del día para el dashboard. |
| `GET` | `/api/diagramas/flota` | Datos formateados para el visualizador de diagramas de turnos. |
| `GET` | `/api/fotos/chofer/:id` | Foto del chofer por ID o DNI. |
| `POST` | `/api/proxy` | Operaciones proxy (guardar novedades, observaciones y estados). |
| `POST` | `/webhook/google` | Recepción de eventos inmediatos para actualizar la caché en caliente. |

---

## 📡 Comunicación en Tiempo Real (Socket.IO)

El servidor expone un servidor Socket.IO configurado con CORS para los dominios de los frontends:
- **Evento `datos_actualizados`:** Se emite a todos los clientes conectados cuando el *Dirty Check* detecta mutaciones en la base de datos o mediante webhook.
- **Evento `novedades_actualizadas`:** Se emite en el namespace `/dash` al cargar nuevas novedades.
- **Detección Inteligente de Cambios:** El servidor calcula un hash MD5 de los datos antes de emitir para evitar tráfico innecesario en la red.

---

## 🧪 Pruebas Locales (Antes de Subir a Render)

Puedes probar el backend localmente ejecutando:
```bash
cd backend_render
npm install
npm start
```
El servidor se iniciará en `http://localhost:3005` conectándose a Supabase y construyendo la memoria RAM inicial.
