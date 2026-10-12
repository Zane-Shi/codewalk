import { createMcpAdapter } from 'pi-mcp-adapter';
import { DEKKO_ROUTE_TOOL_NAMES } from '../dekko-mcp.ts';

const tools = [...DEKKO_ROUTE_TOOL_NAMES];

export default createMcpAdapter({
  config: {
    mcpServers: {
      dekko: {
        command: process.env.CODEWALK_DEKKO_COMMAND?.trim() || 'dekko',
        args: ['serve', '--mcp', '--no-regen'],
        lifecycle: 'lazy',
        protocolVersion: 'legacy',
        directTools: tools,
        includeTools: tools,
        toolPrefix: 'none',
        exposeResources: false,
        requestTimeoutMs: 30000,
        debug: process.env.CODEWALK_MCP_DEBUG === '1',
      },
    },
    settings: {
      toolPrefix: 'none',
      hostConfigDiscovery: 'off',
      notifyOnStartupConnect: false,
      mcpFooterStatus: 'off',
      scriptMode: false,
      disableProxyTool: true,
      strictDirectToolArguments: true,
      outputGuard: {
        maxBytes: 50000,
        maxLines: 1200,
        detailsMaxBytes: 8000,
      },
    },
  },
});
