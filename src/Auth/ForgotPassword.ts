import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import bcrypt from 'bcryptjs';
import { supabase } from '../Database/DB.js';
import { sendPasswordResetEmail } from '../EmailManager.js';
import { createOrUpdateOtp } from './SignIn.js';

const router = new Hono();

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  token: z.string().length(6),
  password: z.string().min(8),
});

/**
 * Step 1: Request Password Reset
 */
router.post('/', zValidator('json', forgotPasswordSchema), async (c) => {
  const { email } = c.req.valid('json');
  try {
    const { data: user } = await supabase.from('users').select('id').eq('email', email).single();
    if (!user) {
      return c.json({ message: 'If an account exists, a reset link has been sent' }, 200);
    }

    const code = await createOrUpdateOtp(email, 'reset');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetLink = `${frontendUrl}/account/reset-password?email=${encodeURIComponent(email)}&token=${code}`;

    await sendPasswordResetEmail(email, resetLink);

    return c.json({ message: 'Reset link sent successfully' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

/**
 * Step 2: Reset Password with Token
 */
router.post('/reset', zValidator('json', resetPasswordSchema), async (c) => {
  const { email, token, password } = c.req.valid('json');

  try {
    const { data: otpData, error: otpError } = await supabase
      .from('auth_codes')
      .select('*')
      .eq('email', email)
      .eq('code', token)
      .eq('type', 'reset')
      .gt('expires_at', new Date().toISOString())
      .single();

    if (otpError || !otpData) {
      return c.json({ error: 'Invalid or expired reset link' }, 400);
    }

    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    const { error: updateError } = await supabase
      .from('users')
      .update({ password_hash: hashedPassword })
      .eq('email', email);

    if (updateError) {
      return c.json({ error: 'Failed to update password' }, 500);
    }

    await supabase.from('auth_codes').delete().eq('email', email).eq('type', 'reset');

    return c.json({ message: 'Password updated successfully' }, 200);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
