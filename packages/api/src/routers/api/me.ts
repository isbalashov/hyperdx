import express from 'express';

import { AI_API_KEY, ANTHROPIC_API_KEY, OIDC_ENABLED, USAGE_STATS_ENABLED } from '@/config';
import { getTeam } from '@/controllers/team';
import { Api404Error } from '@/utils/errors';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    if (req.user == null) {
      throw new Api404Error('Request without user found');
    }

    const {
      _id: id,
      accessKey,
      createdAt,
      email,
      name,
      team: teamId,
    } = req.user;

    const team = await getTeam(teamId);

    return res.json({
      accessKey,
      createdAt,
      email,
      id,
      name,
      team,
      role: (req.user as any).role || 'admin',
      hasOidc: (req.user as any).oidcSubject != null,
      usageStatsEnabled: USAGE_STATS_ENABLED,
      aiAssistantEnabled: !!(AI_API_KEY || ANTHROPIC_API_KEY),
      oidcEnabled: OIDC_ENABLED,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
