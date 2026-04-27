import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS, // App Password
  },
});

export const sendVerificationEmail = async (email: string, code: string) => {
  const mailOptions = {
    from: `"IPTVCloud Support" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Verification Code - IPTVCloud',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e6e6e6; border-radius: 12px; background-color: #f7f8f8;">
        <h2 style="color: #08090a; text-align: center;">Verify your Identity</h2>
        <p style="color: #62666d; font-size: 16px; line-height: 1.5;">Your 6-digit verification code is:</p>
        <div style="background-color: #08090a; color: #f7f8f8; font-size: 32px; font-weight: bold; text-align: center; padding: 20px; border-radius: 8px; letter-spacing: 8px; margin: 20px 0;">
          ${code}
        </div>
        <p style="color: #8a8f98; font-size: 14px; text-align: center;">This code will expire in 30 minutes. If you didn't request this, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #e6e6e6; margin: 20px 0;" />
        <p style="color: #8a8f98; font-size: 12px; text-align: center;">© 2026 IPTVCloud.app. All rights reserved.</p>
      </div>
    `,
  };

  return transporter.sendMail(mailOptions);
};

export const sendPasswordResetEmail = async (email: string, link: string) => {
  const mailOptions = {
    from: `"IPTVCloud Support" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Reset your Password - IPTVCloud',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e6e6e6; border-radius: 12px; background-color: #f7f8f8;">
        <h2 style="color: #08090a; text-align: center;">Reset your Password</h2>
        <p style="color: #62666d; font-size: 16px; line-height: 1.5;">We received a request to reset your password. Click the button below to continue:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${link}" style="background-color: #5e6ad2; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block;">Reset Password</a>
        </div>
        <p style="color: #8a8f98; font-size: 14px;">If you can't click the button, copy and paste this link into your browser:</p>
        <p style="color: #5e6ad2; font-size: 12px; word-break: break-all;">${link}</p>
        <hr style="border: none; border-top: 1px solid #e6e6e6; margin: 20px 0;" />
        <p style="color: #8a8f98; font-size: 12px; text-align: center;">© 2026 IPTVCloud.app. All rights reserved.</p>
      </div>
    `,
  };

  return transporter.sendMail(mailOptions);
};
