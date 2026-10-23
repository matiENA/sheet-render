/**
 * EOR ASISTENTE DE FLOTA — CLIENTE FRONTEND
 */

document.addEventListener('DOMContentLoaded', () => {
    const messagesContainer = document.getElementById('messages-container');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const micBtn = document.getElementById('mic-btn');
    const ttsBtn = document.getElementById('tts-btn');
    const clearBtn = document.getElementById('clear-chat-btn');
    const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
    const sidebar = document.querySelector('.sidebar');
    const chipsContainer = document.getElementById('chips-container');
    const quickQueriesContainer = document.getElementById('quick-queries');

    // Elementos de métricas
    const elTotalUts = document.getElementById('metric-total-uts');
    const elUtsActivas = document.getElementById('metric-uts-activas');
    const elUtsParadas = document.getElementById('metric-uts-paradas');
    const elNovedades = document.getElementById('metric-novedades');
    const elStatusBadge = document.getElementById('ram-status-badge');
    const elModelBadge = document.getElementById('model-badge');

    let chatHistory = [];
    let isWaitingResponse = false;
    let ttsEnabled = false;

    // ==============================================================
    // 📊 1. CARGA INICIAL DE MÉTRICAS Y SUGERENCIAS
    // ==============================================================
    async function cargarMetricas() {
        try {
            const res = await fetch('/api/bot/stats');
            if (!res.ok) return;
            const data = await res.json();
            if (data.success) {
                if (elTotalUts) elTotalUts.textContent = data.total_uts || '0';
                if (elUtsActivas) elUtsActivas.textContent = data.uts_operativas || '0';
                if (elUtsParadas) elUtsParadas.textContent = data.uts_paradas || '0';
                if (elNovedades) elNovedades.textContent = data.novedades_pendientes || '0';
                if (elModelBadge) {
                    elModelBadge.innerHTML = data.modo_ia === 'GEMINI_2.5_FLASH' 
                        ? '⚡ Gemini 2.5 Flash + RAM' 
                        : '💾 Motor Local RAM';
                }
            }
        } catch (e) {
            console.warn("No se pudieron cargar métricas de RAM:", e);
        }
    }

    async function cargarSugerencias() {
        try {
            const res = await fetch('/api/bot/sugerencias');
            if (!res.ok) return;
            const data = await res.json();
            if (data.success && Array.isArray(data.sugerencias)) {
                // Renderizar en el carrusel de chips
                if (chipsContainer) {
                    chipsContainer.innerHTML = '';
                    data.sugerencias.slice(0, 5).forEach(s => {
                        const chip = document.createElement('div');
                        chip.className = 'chip';
                        chip.innerHTML = `${s.icono} ${s.texto}`;
                        chip.addEventListener('click', () => enviarPregunta(s.texto));
                        chipsContainer.appendChild(chip);
                    });
                }

                // Renderizar en la barra lateral
                if (quickQueriesContainer) {
                    quickQueriesContainer.innerHTML = '';
                    data.sugerencias.forEach(s => {
                        const btn = document.createElement('button');
                        btn.className = 'quick-btn';
                        btn.innerHTML = `<span>${s.icono}</span> <span>${s.texto}</span>`;
                        btn.addEventListener('click', () => {
                            enviarPregunta(s.texto);
                            if (window.innerWidth <= 768) sidebar.classList.remove('open');
                        });
                        quickQueriesContainer.appendChild(btn);
                    });
                }
            }
        } catch (e) {
            console.warn("No se pudieron cargar sugerencias:", e);
        }
    }

    cargarMetricas();
    cargarSugerencias();
    setInterval(cargarMetricas, 30000); // Refresco periódico cada 30s

    // ==============================================================
    // 💬 2. ENVÍO Y RENDERIZADO DE MENSAJES
    // ==============================================================
    async function enviarPregunta(texto = null) {
        const pregunta = (texto || userInput.value || '').trim();
        if (!pregunta || isWaitingResponse) return;

        // Limpiar input y reajustar altura
        userInput.value = '';
        autoResizeTextarea();

        // Agregar mensaje de usuario al chat
        appendMessage('user', pregunta);
        chatHistory.push({ rol: 'user', contenido: pregunta });

        // Mostrar indicador de escritura
        isWaitingResponse = true;
        const typingEl = appendTypingIndicator();
        scrollToBottom();

        try {
            const res = await fetch('/api/bot/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pregunta, historial: chatHistory })
            });

            const data = await res.json();
            typingEl.remove();

            if (data.success) {
                appendMessage('assistant', data.respuesta, data.herramientas_usadas, data.tiempo_ms);
                chatHistory.push({ rol: 'assistant', contenido: data.respuesta });

                if (ttsEnabled) {
                    leerEnVozAlta(data.respuesta);
                }
            } else {
                appendMessage('assistant', `⚠️ *Error al procesar consulta:* ${data.error || 'Intente nuevamente.'}`);
            }
        } catch (err) {
            typingEl.remove();
            appendMessage('assistant', `❌ *Error de conexión con el servidor:* ${err.message}`);
        } finally {
            isWaitingResponse = false;
            scrollToBottom();
            userInput.focus();
        }
    }

    function appendMessage(sender, text, tools = [], tiempoMs = 0) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${sender}`;

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.innerHTML = sender === 'user' ? '👤' : '🚚';

        const bubble = document.createElement('div');
        bubble.className = 'bubble';

        // Si el asistente usó herramientas de RAM/Storage, mostrar badge informativo
        if (sender === 'assistant' && tools && tools.length > 0) {
            const toolsBar = document.createElement('div');
            toolsBar.className = 'tools-indicator';
            const nombres = tools.map(t => t.herramienta.replace('_', ' ')).join(', ');
            toolsBar.innerHTML = `⚡ <span>Consultó: <strong>${nombres}</strong> (${tiempoMs}ms)</span>`;
            bubble.appendChild(toolsBar);
        }

        const contentDiv = document.createElement('div');
        contentDiv.className = 'bubble-content';
        contentDiv.innerHTML = parseMarkdown(text);
        bubble.appendChild(contentDiv);

        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        const now = new Date();
        timeDiv.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        bubble.appendChild(timeDiv);

        msgDiv.appendChild(avatar);
        msgDiv.appendChild(bubble);

        messagesContainer.appendChild(msgDiv);
        scrollToBottom();
        return msgDiv;
    }

    function appendTypingIndicator() {
        const wrap = document.createElement('div');
        wrap.className = 'message assistant typing';

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.innerHTML = '🚚';

        const indicator = document.createElement('div');
        indicator.className = 'typing-indicator';
        indicator.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';

        wrap.appendChild(avatar);
        wrap.appendChild(indicator);
        messagesContainer.appendChild(wrap);
        return wrap;
    }

    function scrollToBottom() {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // ==============================================================
    // 📝 3. PARSER LIGERO DE MARKDOWN A HTML
    // ==============================================================
    function parseMarkdown(md) {
        if (!md) return '';
        let html = md;

        // Escape básico de HTML innecesario
        html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Encabezados
        html = html.replace(/^### (.*$)/gim, '<h4>$1</h4>');
        html = html.replace(/^## (.*$)/gim, '<h3>$1</h3>');

        // Negrita e Itálica
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

        // Blockquotes / Alertas
        html = html.replace(/^&gt; (.*$)/gim, '<blockquote style="border-left: 3px solid var(--accent-cyan); padding-left: 10px; margin: 6px 0; color: #94A3B8;">$1</blockquote>');

        // Tablas Markdown
        const tableRegex = /((?:\|.+?\|\r?\n)+)/g;
        html = html.replace(tableRegex, (match) => {
            const rows = match.trim().split('\n').map(r => r.trim());
            if (rows.length < 2) return match;
            
            let tableHtml = '<table>';
            rows.forEach((row, rIdx) => {
                if (row.includes('---')) return; // Separador
                const cells = row.split('|').slice(1, -1).map(c => c.trim());
                if (rIdx === 0) {
                    tableHtml += '<thead><tr>' + cells.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
                } else {
                    tableHtml += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
                }
            });
            tableHtml += '</tbody></table>';
            return tableHtml;
        });

        // Listas con viñetas
        html = html.replace(/^\s*[•\-]\s+(.*$)/gim, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>)/gims, '<ul>$1</ul>');

        // Párrafos y saltos de línea
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br/>');

        return `<p>${html}</p>`;
    }

    // ==============================================================
    // 🎙️ 4. ENTRADA POR VOZ (RECONOCIMIENTO DE HABLA)
    // ==============================================================
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;

    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.lang = 'es-AR';
        recognition.continuous = false;
        recognition.interimResults = false;

        recognition.onstart = () => {
            micBtn.classList.add('active-mic');
            userInput.placeholder = "Escuchando tu pregunta...";
        };

        recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            userInput.value = transcript;
            autoResizeTextarea();
            enviarPregunta(transcript);
        };

        recognition.onerror = (event) => {
            console.warn("Error en reconocimiento de voz:", event.error);
            micBtn.classList.remove('active-mic');
            userInput.placeholder = "Escribe o dicta tu pregunta...";
        };

        recognition.onend = () => {
            micBtn.classList.remove('active-mic');
            userInput.placeholder = "Escribe o dicta tu pregunta...";
        };

        micBtn.addEventListener('click', () => {
            try {
                if (micBtn.classList.contains('active-mic')) {
                    recognition.stop();
                } else {
                    recognition.start();
                }
            } catch (e) {
                console.error("Error al iniciar micrófono:", e);
            }
        });
    } else {
        if (micBtn) {
            micBtn.style.opacity = '0.3';
            micBtn.title = "Reconocimiento de voz no soportado en este navegador";
        }
    }

    // ==============================================================
    // 🔊 5. LECTURA EN VOZ ALTA (TEXT-TO-SPEECH)
    // ==============================================================
    if (ttsBtn) {
        ttsBtn.addEventListener('click', () => {
            ttsEnabled = !ttsEnabled;
            ttsBtn.style.color = ttsEnabled ? 'var(--accent-cyan)' : 'var(--text-muted)';
            ttsBtn.title = ttsEnabled ? 'Voz activada' : 'Voz desactivada';
        });
    }

    function leerEnVozAlta(texto) {
        if (!('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel(); // Detener cualquier locución previa
        // Limpiar markdown
        const textoLimpio = texto.replace(/[*#_`>~|\[\]]/g, ' ').replace(/\n+/g, '. ');
        const utterance = new SpeechSynthesisUtterance(textoLimpio);
        utterance.lang = 'es-ES';
        utterance.rate = 1.05;
        window.speechSynthesis.speak(utterance);
    }

    // ==============================================================
    // ⌨️ 6. EVENTOS DE TECLADO Y REDIMENSIONAMIENTO
    // ==============================================================
    function autoResizeTextarea() {
        userInput.style.height = 'auto';
        userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
    }

    userInput.addEventListener('input', autoResizeTextarea);

    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            enviarPregunta();
        }
    });

    sendBtn.addEventListener('click', () => enviarPregunta());

    // Limpiar conversación
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (confirm("¿Deseas reiniciar la conversación?")) {
                chatHistory = [];
                messagesContainer.innerHTML = '';
                // Restaurar mensaje de bienvenida
                const welcome = document.createElement('div');
                welcome.className = 'message assistant';
                welcome.innerHTML = `
                    <div class="avatar">🚚</div>
                    <div class="bubble">
                        <div class="bubble-content">
                            <h3>👋 ¡Hola! Soy el Asistente Operativo de la Flota.</h3>
                            <p>Tengo acceso instantáneo a la memoria RAM del sistema con <strong>171 choferes</strong>, <strong>270 UTs</strong>, novedades de taller y viajes de ruta.</p>
                            <p>Pregúntame lo que necesites en español, o selecciona una de las sugerencias rápidas abajo.</p>
                        </div>
                    </div>
                `;
                messagesContainer.appendChild(welcome);
            }
        });
    }

    // Toggle Sidebar en móviles
    if (toggleSidebarBtn) {
        toggleSidebarBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
        });
    }
});
