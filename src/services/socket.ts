let socket: WebSocket | null = null;
let messageHandlers: Set<(data: any) => void> = new Set();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isConnecting = false;

function connect() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    socket = new WebSocket('ws://localhost:3000/audio-stream');

    socket.onopen = () => {
      isConnecting = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      console.log('[Jarvis HUD] Connected to Brain ✓');
      // Notify all handlers that connection is live
      messageHandlers.forEach(h => h({ type: '_connected' }));
    };

    socket.onclose = () => {
      isConnecting = false;
      console.log('[Jarvis HUD] Disconnected — retrying in 2s...');
      scheduleReconnect();
    };

    socket.onerror = () => {
      isConnecting = false;
      socket?.close(); // triggers onclose → scheduleReconnect
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        messageHandlers.forEach(handler => handler(data));
      } catch (e) {
        console.error('Error parsing WS message', e);
      }
    };
  } catch (e) {
    isConnecting = false;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000); // retry every 2 seconds
}

// Start connecting immediately on module load
connect();

export const getJarvisSocket = (): WebSocket | null => socket;

export const addSocketListener = (handler: (data: any) => void) => {
  messageHandlers.add(handler);
};

export const removeSocketListener = (handler: (data: any) => void) => {
  messageHandlers.delete(handler);
};
