export const WHATSAPP_CONNECTION_LIMIT = 3;

export function getWhatsAppConnectionCapacity(connectionCount: number) {
  return {
    limit: WHATSAPP_CONNECTION_LIMIT,
    reached: connectionCount >= WHATSAPP_CONNECTION_LIMIT,
  };
}
