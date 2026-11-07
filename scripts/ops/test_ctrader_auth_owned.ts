import assert from 'node:assert/strict';
import { authenticateOwnedClient } from '../../src/services/ctrader_auth_owned.js';
const credentials = { clientId: 'fake', clientSecret: 'fake', accountId: 1, accessToken: 'fake' };
for (const failAt of ['transport', 'application', 'account', 'none']) {
    let closed = 0;
    const error = new Error('simulated CANT_ROUTE_REQUEST');
    const stage = async (name: string) => { if (failAt === name) throw error; };
    const client = {
        connection: { connect: () => stage('transport') },
        raw: { auth: { authenticateApp: () => stage('application'), authenticateAccount: () => stage('account') } },
        disconnect: () => { closed++; },
    };
    if (failAt === 'none') {
        assert.equal(await authenticateOwnedClient(client, credentials), client);
        assert.equal(closed, 0);
    } else {
        await assert.rejects(authenticateOwnedClient(client, credentials), e => e === error);
        assert.equal(closed, 1);
    }
    console.log('PASS', failAt);
}
const original = new Error('auth failed');
await assert.rejects(authenticateOwnedClient({
    connection: { connect: async () => {} },
    raw: { auth: { authenticateApp: async () => { throw original; }, authenticateAccount: async () => {} } },
    disconnect: () => { throw new Error('cleanup failed'); },
}, credentials), e => e === original);
console.log('PASS cleanup failure preserves original auth error');
console.log('AUTOTEST OK (no broker, no credentials, no orders)');
