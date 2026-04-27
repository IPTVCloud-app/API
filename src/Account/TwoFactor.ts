import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import { supabase } from '../Database/DB.js';
import { authMiddleware } from '../Middleware/Auth.js';

const router = new Hono();

router.use('*', authMiddleware);

/**
 * Check 2FA Status
 */
router.get('/status', async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;

  try {
    const { data: twoFactor, error } = await supabase
      .from('two_factor_secrets')
      .select('is_enabled')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    return c.json({ is_enabled: twoFactor?.is_enabled || false }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

/**
 * Generate 2FA Secret & QR Code
 */
router.post('/setup', async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;
  const email = payload.email;

  try {
    const secret = speakeasy.generateSecret({ name: `IPTVCloud (${email})` });

    // Store unverified secret temporarily or overwrite existing disabled secret
    const { error } = await supabase
      .from('two_factor_secrets')
      .upsert({ 
        user_id: userId, 
        secret: secret.base32, 
        is_enabled: false,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

    if (error) throw error;

    const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url || '');

    return c.json({ 
      secret: secret.base32,
      qrCodeUrl 
    }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

const verifySchema = z.object({
  code: z.string().length(6),
});

/**
 * Verify & Enable 2FA
 */
router.post('/verify', zValidator('json', verifySchema), async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;
  const { code } = c.req.valid('json');

  try {
    const { data: twoFactor, error } = await supabase
      .from('two_factor_secrets')
      .select('secret, is_enabled')
      .eq('user_id', userId)
      .single();

    if (error || !twoFactor) {
      return c.json({ error: '2FA setup not initialized' }, 400);
    }

    if (twoFactor.is_enabled) {
      return c.json({ error: '2FA is already enabled' }, 400);
    }

    const verified = speakeasy.totp.verify({
      secret: twoFactor.secret,
      encoding: 'base32',
      token: code,
      window: 1 // Allow 30s drift
    });

    if (!verified) {
      return c.json({ error: 'Invalid authentication code' }, 400);
    }

    const { error: updateError } = await supabase
      .from('two_factor_secrets')
      .update({ is_enabled: true, updated_at: new Date().toISOString() })
      .eq('user_id', userId);

    if (updateError) throw updateError;

    return c.json({ message: '2FA enabled successfully' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

/**
 * Disable 2FA
 */
router.post('/disable', zValidator('json', verifySchema), async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;
  const { code } = c.req.valid('json');

  try {
    const { data: twoFactor, error } = await supabase
      .from('two_factor_secrets')
      .select('secret, is_enabled')
      .eq('user_id', userId)
      .single();

    if (error || !twoFactor || !twoFactor.is_enabled) {
      return c.json({ error: '2FA is not enabled' }, 400);
    }

    const verified = speakeasy.totp.verify({
      secret: twoFactor.secret,
      encoding: 'base32',
      token: code,
      window: 1
    });

    if (!verified) {
      return c.json({ error: 'Invalid authentication code' }, 400);
    }

    const { error: deleteError } = await supabase
      .from('two_factor_secrets')
      .delete()
      .eq('user_id', userId);

    if (deleteError) throw deleteError;

    return c.json({ message: '2FA disabled successfully' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

export default router;
