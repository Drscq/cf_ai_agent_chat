import { Agent, routeAgentRequest } from "agents";

export interface Env {
    AI: any;
    ChatAgent: DurableObjectNamespace;
}

export class ChatAgent extends Agent<Env> {
    async ensureTable() {
        await this.sql`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT,
        content TEXT,
        timestamp INTEGER
      )
    `;
    }

    async getHistory() {
        await this.ensureTable();
        const result = await this.sql`SELECT role, content FROM history ORDER BY timestamp ASC`;
        return Array.from(result) as { role: string; content: string }[];
    }

    async chat(message: string) {
        await this.ensureTable();
        await this.sql`INSERT INTO history (role, content, timestamp) VALUES (${"user"}, ${message}, ${Date.now()})`;

        const history = await this.getHistory();
        const messages = history.map((h) => ({ role: h.role, content: h.content }));

        const systemMessage = { role: "system", content: "You are a helpful assistant powered by Cloudflare Agents and Llama 3.3. You are concise and friendly." };
        const context = [systemMessage, ...messages];

        let reply = "Error generating response.";
        try {
            const response = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: context
            });
            // @ts-ignore
            reply = response.response || (response as any).result?.response || JSON.stringify(response);
        } catch (e) {
            reply = "Error: " + e;
        }

        await this.sql`INSERT INTO history (role, content, timestamp) VALUES (${"assistant"}, ${reply}, ${Date.now()})`;

        return reply;
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
        
        // This relies on RPC routing provided by 'agents' SDK via Worker
        // Assuming default routing: /<Namespace>/<Name>/<Method>
        const AGENT_ENDPOINT = "/ChatAgent/default/chat";

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
                // The Agents SDK typically expects an array of args
                const response = await fetch(AGENT_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify([text]) 
                });
                
                if (!response.ok) throw new Error("Network error: " + response.statusText);
                
                const data = await response.json();
                // Response might be the direct result or wrapped
                const reply = data; 
                
                addMessage('assistant', reply);
            } catch (err) {
                addMessage('assistant', "Error: " + err.message);
            }
        });
    </script>
</body>
</html>
`;

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
            return new Response(HTML, { headers: { "Content-Type": "text/html" } });
        }

        // Fallback to Agent routing
        // This will handle /ChatAgent/default/chat
        return routeAgentRequest(request, env);
    }
};
