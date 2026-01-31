import prompts from 'prompts';
import { google } from 'googleapis';
import { SparrowConfig, saveConfig, setSecret } from '../config/config.js';
import { logger } from '../lib/logger.js';

export async function runGoogleAuth(cfg: SparrowConfig) {
  const responses = await prompts(
    [
      {
        type: 'text',
        name: 'clientId',
        message: 'Google OAuth Client ID',
        initial: cfg.google?.clientId ?? process.env.GOOGLE_CLIENT_ID ?? '',
      },
      {
        type: 'password',
        name: 'clientSecret',
        message: 'Google OAuth Client Secret',
        initial: process.env.GOOGLE_CLIENT_SECRET ?? '',
      },
    ],
    { onCancel: () => ({}) as any }
  );

  const clientId = responses.clientId?.trim();
  const clientSecret = responses.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Client ID and secret are required for Google auth.');
  }

  const scopes = cfg.google?.scopes ?? [];
  const redirectUri = cfg.google?.redirectUri ?? 'urn:ietf:wg:oauth:2.0:oob';
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });

  console.log('\nOpen this URL in your browser to authorize Sparrow:');
  console.log(authUrl);

  const { code } = await prompts({ type: 'text', name: 'code', message: 'Paste the authorization code' });
  if (!code) throw new Error('No authorization code provided.');

  const { tokens } = await oauth2Client.getToken(code);
  logger.info('Received Google tokens.');

  const googleBlock = { ...(cfg.google ?? {}), clientId, tokenEnc: undefined };
  let updated: SparrowConfig = { ...cfg, google: googleBlock };
  updated = setSecret(updated, 'google.clientSecret', clientSecret);
  updated = setSecret(updated, 'google.token', JSON.stringify(tokens));
  saveConfig(updated);
  console.log('Google credentials saved.');
  return updated;
}
