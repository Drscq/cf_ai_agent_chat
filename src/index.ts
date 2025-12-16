export interface Env {
    AI: Ai;
    ChatAgent: DurableObjectNamespace;
}

// Using a simpler Durable Object pattern instead of the agents SDK
export class ChatAgent implements DurableObject {
    private sql: SqlStorage;
    private env: Env;

    constructor(state: DurableObjectState, env: Env) {
        this.sql = state.storage.sql;
        this.env = env;
        this.ensureTable();
    }

    private ensureTable() {
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT,
                content TEXT,
                timestamp INTEGER
            )
        `);
    }

    private getHistory(): { role: string; content: string }[] {
        const result = this.sql.exec("SELECT role, content FROM history ORDER BY timestamp ASC");
        return Array.from(result) as { role: string; content: string }[];
    }

    async chat(message: string): Promise<string> {
        // Save user message
        this.sql.exec(
            "INSERT INTO history (role, content, timestamp) VALUES (?, ?, ?)",
            "user", message, Date.now()
        );

        const history = this.getHistory();
        const messages = history.map((h) => ({ role: h.role, content: h.content }));

        const systemMessage = {
            role: "system",
            content: "You are a helpful assistant powered by Cloudflare Agents and Llama 3.3. You are concise and friendly."
        };
        const context = [systemMessage, ...messages];

        let reply = "Error generating response.";
        try {
            const response = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: context
            });
            reply = (response as any).response || JSON.stringify(response);
        } catch (e) {
            reply = "Error: " + String(e);
        }

        // Save assistant message
        this.sql.exec(
            "INSERT INTO history (role, content, timestamp) VALUES (?, ?, ?)",
            "assistant", reply, Date.now()
        );

        return reply;
    }

    async fetch(request: Request): Promise<Response> {
        if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
        }

        try {
            const body = await request.json() as string[];
            const message = Array.isArray(body) ? body[0] : String(body);
            const reply = await this.chat(message);
            return new Response(JSON.stringify(reply), {
                headers: { "Content-Type": "application/json" }
            });
        } catch (e) {
            return new Response(JSON.stringify({ error: String(e) }), {
                status: 500,
                headers: { "Content-Type": "application/json" }
            });
        }
    }
}

const HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare AI Chat</title>
    <style>
        :root {
            --bg-color: #0d1117;
            --chat-bg: #161b22;
            --primary: #58a6ff;
            --text: #c9d1d9;
            --user-bubble: #1f6feb;
            --ai-bubble: #21262d;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
            background-color: var(--bg-color);
            color: var(--text);
            margin: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        header {
            padding: 1rem;
            background: var(--chat-bg);
            border-bottom: 1px solid #30363d;
            text-align: center;
            font-weight: bold;
            font-size: 1.2rem;
            background: linear-gradient(90deg, #1f6feb, #58a6ff);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        #chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 1rem;
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }
        .message {
            max-width: 80%;
            padding: 0.8rem 1rem;
            border-radius: 1rem;
            line-height: 1.5;
            animation: fadeIn 0.3s ease;
        }
        .message.user {
            align-self: flex-end;
            background-color: var(--user-bubble);
            color: white;
            border-bottom-right-radius: 0.2rem;
        }
        .message.assistant {
            align-self: flex-start;
            background-color: var(--ai-bubble);
            border-bottom-left-radius: 0.2rem;
            border: 1px solid #30363d;
        }
        #input-area {
            padding: 1rem;
            background: var(--chat-bg);
            border-top: 1px solid #30363d;
            display: flex;
            gap: 0.5rem;
        }
        input {
            flex: 1;
            padding: 0.8rem;
            border-radius: 0.5rem;
            border: 1px solid #30363d;
            background: #0d1117;
            color: white;
            font-size: 1rem;
            outline: none;
        }
        input:focus {
            border-color: var(--primary);
        }
        button {
            padding: 0 1.5rem;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 0.5rem;
            font-weight: bold;
            cursor: pointer;
            transition: opacity 0.2s;
        }
        button:hover {
            opacity: 0.9;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
    </style>
</head>
<body>
    <header>Cloudflare Agent Llama 3.3</header>
    <div id="chat-container"></div>
    <form id="input-area">
        <input type="text" id="message-input" placeholder="Type a message..." autocomplete="off">
        <button type="submit">Send</button>
    </form>

    <script>
        const container = document.getElementById('chat-container');
        const form = document.getElementById('input-area');
        const input = document.getElementById('message-input');
        
        const AGENT_ENDPOINT = "/api/chat";

        function addMessage(role, text) {
            const div = document.createElement('div');
            div.className = \`message \${role}\`;
            div.textContent = text;
            container.appendChild(div);
            container.scrollTop = container.scrollHeight;
        }

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;

            addMessage('user', text);
            input.value = '';

            try {
                const response = await fetch(AGENT_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify([text]) 
                });
                
                if (!response.ok) throw new Error("Network error: " + response.statusText);
                
                const data = await response.json();
                addMessage('assistant', data);
            } catch (err) {
                addMessage('assistant', "Error: " + err.message);
            }
        });
    </script>
</body>
</html>
`;

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // Serve the HTML frontend
        if (url.pathname === "/" || url.pathname === "/index.html") {
            return new Response(HTML, { headers: { "Content-Type": "text/html" } });
        }

        // Handle favicon requests
        if (url.pathname === "/favicon.ico") {
            return new Response(null, { status: 204 });
        }

        // Handle chat API endpoint
        if (url.pathname === "/api/chat" && request.method === "POST") {
            try {
                // Get or create a Durable Object instance
                const id = env.ChatAgent.idFromName("default");
                const stub = env.ChatAgent.get(id);

                // Forward request to Durable Object
                return stub.fetch(request);
            } catch (e) {
                return new Response(JSON.stringify({ error: String(e) }), {
                    status: 500,
                    headers: { "Content-Type": "application/json" }
                });
            }
        }

        // Fallback 404
        return new Response("Not Found", { status: 404 });
    }
};
