import { WebhookService } from '@hyperdx/common-utils/dist/types';
import { ObjectId } from 'mongodb';
import request, { SuperAgentTest } from 'supertest';

import { getLoggedInAgent, getServer } from '../../../fixtures';
import { ITeam } from '../../../models/team';
import { IUser } from '../../../models/user';
import Webhook from '../../../models/webhook';

const WEBHOOKS_BASE_URL = '/api/v2/webhooks';

const MOCK_WEBHOOK = {
  name: 'Test Webhook',
  service: WebhookService.Slack,
  url: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
  description: 'Test webhook for Slack',
  queryParams: { param1: 'value1' },
  headers: { 'X-Custom-Header': 'Header Value' },
  body: '{"text": "Test message"}',
};

describe('External API v2 Webhooks', () => {
  const server = getServer();
  let agent: SuperAgentTest;
  let team: ITeam;
  let user: IUser;

  beforeAll(async () => {
    await server.start();
  });

  beforeEach(async () => {
    const result = await getLoggedInAgent(server);
    agent = result.agent;
    team = result.team;
    user = result.user;
  });

  afterEach(async () => {
    await server.clearDBs();
  });

  afterAll(async () => {
    await server.stop();
  });

  const authRequest = (
    method: 'get' | 'post' | 'put' | 'delete',
    url: string,
  ) => {
    return agent[method](url).set('Authorization', `Bearer ${user?.accessKey}`);
  };

  describe('GET /api/v2/webhooks', () => {
    it('should return an empty list when no webhooks exist', async () => {
      const response = await authRequest('get', WEBHOOKS_BASE_URL).expect(200);

      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toEqual({ data: [] });
    });

    it('should list webhooks for the authenticated team', async () => {
      await Webhook.create({ ...MOCK_WEBHOOK, team: team._id });

      const response = await authRequest('get', WEBHOOKS_BASE_URL).expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        id: expect.any(String),
        name: MOCK_WEBHOOK.name,
        service: MOCK_WEBHOOK.service,
        url: MOCK_WEBHOOK.url,
        description: MOCK_WEBHOOK.description,
        queryParams: MOCK_WEBHOOK.queryParams,
        headers: MOCK_WEBHOOK.headers,
        body: MOCK_WEBHOOK.body,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('should return multiple webhooks', async () => {
      await Webhook.create({ ...MOCK_WEBHOOK, team: team._id });
      await Webhook.create({
        ...MOCK_WEBHOOK,
        name: 'Second Webhook',
        service: WebhookService.Generic,
        url: 'https://example.com/webhook',
        team: team._id,
      });

      const response = await authRequest('get', WEBHOOKS_BASE_URL).expect(200);

      expect(response.body.data).toHaveLength(2);
      const names = response.body.data.map(w => w.name);
      expect(names).toContain('Test Webhook');
      expect(names).toContain('Second Webhook');
    });

    it('should not return webhooks belonging to another team', async () => {
      // Create a webhook for the current team
      await Webhook.create({ ...MOCK_WEBHOOK, team: team._id });

      // Create a webhook directly in the DB for a different team
      const otherTeamId = new ObjectId();
      await Webhook.create({
        ...MOCK_WEBHOOK,
        name: 'Other Team Webhook',
        team: otherTeamId,
      });

      const response = await authRequest('get', WEBHOOKS_BASE_URL).expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].name).toBe(MOCK_WEBHOOK.name);
    });

    it('should work with a minimal webhook (no optional fields)', async () => {
      await Webhook.create({
        name: 'Minimal Webhook',
        service: WebhookService.Generic,
        team: team._id,
      });

      const response = await authRequest('get', WEBHOOKS_BASE_URL).expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        id: expect.any(String),
        name: 'Minimal Webhook',
        service: WebhookService.Generic,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(response.body.data[0]).not.toHaveProperty('url');
      expect(response.body.data[0]).not.toHaveProperty('description');
      expect(response.body.data[0]).not.toHaveProperty('queryParams');
      expect(response.body.data[0]).not.toHaveProperty('headers');
      expect(response.body.data[0]).not.toHaveProperty('body');
    });

    it('should require authentication', async () => {
      await request(server.getHttpServer()).get(WEBHOOKS_BASE_URL).expect(401);
    });
  });
});
