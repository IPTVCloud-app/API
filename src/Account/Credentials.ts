import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import { supabase } from '../Database/DB.js';
import { authMiddleware } from '../Middleware/Auth.js';
import { createOrUpdateOtp } from '../Auth/SignIn.js';
import { sendVerificationEmail } from '../EmailManager.js';

const router = new Hono();

router.use('*', authMiddleware);

/**
 * Helper: Check 2FA or OTP for sensitive actions
 */
async function verifyAuth(userId: string, code: string, email: string): Promise<boolean> {
  const { data: twoFactor } = await supabase
    .from('two_factor_secrets')
    .select('secret, is_enabled')
    .eq('user_id', userId)
    .single();

  if (twoFactor && twoFactor.is_enabled) {
    // Verify 2FA code
    return speakeasy.totp.verify({
      secret: twoFactor.secret,
      encoding: 'base32',
      token: code,
      window: 1
    });
  }

  // Verify OTP
  const { data: otpData } = await supabase
    .from('auth_codes')
    .select('*')
    .eq('email', email)
    .eq('code', code)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (otpData) {
    await supabase.from('auth_codes').delete().eq('id', otpData.id);
    return true;
  }

  return false;
}

/**
 * Request OTP for credential change (if 2FA is not enabled)
 */
router.post('/request-otp', async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;
  const email = payload.email;

  const { data: twoFactor } = await supabase
    .from('two_factor_secrets')
    .select('is_enabled')
    .eq('user_id', userId)
    .single();

  if (twoFactor?.is_enabled) {
    return c.json({ message: '2FA is enabled. Please use your authenticator app.' }, 200);
  }

  try {
    const code = await createOrUpdateOtp(email, 'verify_email');
    await sendVerificationEmail(email, code);
    return c.json({ message: 'Verification code sent to your email.' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(6),
  newPassword: z.string().min(8),
  authCode: z.string().length(6), // OTP or 2FA code
});

/**
 * Change Password
 */
router.put('/password', zValidator('json', changePasswordSchema), async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;
  const email = payload.email;
  const { currentPassword, newPassword, authCode } = c.req.valid('json');

  try {
    const { data: user } = await supabase.from('users').select('password_hash').eq('id', userId).single();
    if (!user) return c.json({ error: 'User not found' }, 404);

    const isPasswordValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isPasswordValid) return c.json({ error: 'Invalid current password' }, 400);

    const isAuthValid = await verifyAuth(userId, authCode, email);
    if (!isAuthValid) return c.json({ error: 'Invalid verification code' }, 400);

    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await supabase.from('users').update({ password_hash: hashedPassword }).eq('id', userId);

    return c.json({ message: 'Password updated successfully' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

const changeEmailSchema = z.object({
  newEmail: z.string().email(),
  authCode: z.string().length(6),
});

/**
 * Change Email
 */
router.put('/email', zValidator('json', changeEmailSchema), async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;
  const currentEmail = payload.email;
  const { newEmail, authCode } = c.req.valid('json');

  try {
    const isAuthValid = await verifyAuth(userId, authCode, currentEmail);
    if (!isAuthValid) return c.json({ error: 'Invalid verification code' }, 400);

    const { error: updateError } = await supabase.from('users').update({ email: newEmail }).eq('id', userId);
    if (updateError) return c.json({ error: 'Email already taken or invalid' }, 400);

    return c.json({ message: 'Email updated successfully. Please sign in again.' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

const changeUsernameSchema = z.object({
  newUsername: z.string().min(3),
  authCode: z.string().length(6),
});

/**
 * Change Username
 */
router.put('/username', zValidator('json', changeUsernameSchema), async (c) => {
  const payload = c.get('jwtPayload') as any;
  const userId = payload.id;
  const email = payload.email;
  const { newUsername, authCode } = c.req.valid('json');

  try {
    const isAuthValid = await verifyAuth(userId, authCode, email);
    if (!isAuthValid) return c.json({ error: 'Invalid verification code' }, 400);

    const { error: updateError } = await supabase.from('users').update({ username: newUsername }).eq('id', userId);
    if (updateError) return c.json({ error: 'Username already taken or invalid' }, 400);

    return c.json({ message: 'Username updated successfully.' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

export default router;
