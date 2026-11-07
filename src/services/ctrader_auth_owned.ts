/** Keep ownership of the transport until auth completes, including failed handshakes. */
export async function authenticateOwnedClient<T extends {
    connection: { connect(): Promise<unknown> };
    raw: { auth: {
        authenticateApp(clientId: string, clientSecret: string): Promise<unknown>;
        authenticateAccount(accountId: number, accessToken: string): Promise<unknown>;
    } };
    disconnect(): void;
}>(client: T, credentials: { clientId: string; clientSecret: string; accountId: number; accessToken: string }): Promise<T> {
    try {
        await client.connection.connect();
        await client.raw.auth.authenticateApp(credentials.clientId, credentials.clientSecret);
        await client.raw.auth.authenticateAccount(credentials.accountId, credentials.accessToken);
        return client;
    } catch (error) {
        // Never replace the authentication error if cleanup itself fails.
        try { client.disconnect(); } catch { /* original error remains authoritative */ }
        throw error;
    }
}
