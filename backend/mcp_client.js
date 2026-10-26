const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function createStitchClient() {
    const transport = new StdioClientTransport({
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['-y', 'stitch-mcp'],
        env: {
            ...process.env,
            GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT
        }
    });

    const client = new Client(
        { name: 'jarvis-developer-agent', version: '1.0.0' },
        { capabilities: { tools: {} } }
    );

    await client.connect(transport);
    console.log('[MCP] Connected to Stitch MCP Server.');
    
    const toolsResult = await client.listTools();
    console.log(`[MCP] Loaded ${toolsResult.tools.length} tools from Stitch MCP.`);
    
    return { client, tools: toolsResult.tools };
}

module.exports = { createStitchClient };
