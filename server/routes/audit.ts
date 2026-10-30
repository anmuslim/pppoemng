import { Router, Response } from 'express';
import { storage } from '../storage.js';

const router = Router();

router.get('/', (_req, res: Response) => {
  res.json({ success: true, data: storage.getAuditLogs() });
});

export default router;
