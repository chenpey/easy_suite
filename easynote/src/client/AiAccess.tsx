import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, LoaderCircle, Plus, Trash2, X } from 'lucide-react';
import type { IntegrationToken } from '../shared/types';
import { api } from './api';
import { dateLocale, t } from './i18n';

interface Props {
  disabled: boolean;
  reportError(error: string): void;
  notify(message: string): void;
}

const expiry = (value: number | null) => value === null ? t('never_expires') : t('share_until', new Date(value).toLocaleDateString(dateLocale(), {
  year: 'numeric', month: 'short', day: 'numeric',
}));

export function AiAccess({ disabled, reportError, notify }: Props) {
  const [tokens, setTokens] = useState<IntegrationToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<IntegrationToken['access']>('read-write');
  const [expiresInDays, setExpiresInDays] = useState('90');
  const [secret, setSecret] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState('');
  const codexConfig = secret ? `[mcp_servers.easynote]\nurl = "${location.origin}/mcp"\nhttp_headers = { Authorization = "Bearer ${secret}" }` : '';

  useEffect(() => {
    let active = true;
    void api.integrationTokens()
      .then((result) => { if (active) setTokens(result.tokens); })
      .catch((error: unknown) => { if (active) reportError(String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reportError]);

  const create = async () => {
    setWorking(true);
    setSecret('');
    try {
      const result = await api.createIntegrationToken(name, access, expiresInDays === 'permanent' ? null : Number(expiresInDays));
      setTokens((current) => [result.token, ...current]);
      setSecret(result.secret);
      setName('');
      notify(t('token_created'));
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking(false);
    }
  };

  const revoke = async (id: string) => {
    setWorking(true);
    try {
      await api.revokeIntegrationToken(id);
      setTokens((current) => current.filter((item) => item.id !== id));
      setConfirmRevoke('');
      notify(t('token_revoked'));
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorking(false);
    }
  };

  return <section className="ai-access" aria-labelledby="ai-access-title">
    <div className="setting-row ai-access-heading">
      <span id="ai-access-title">{t('ai_access')}</span>
      <KeyRound size={17} />
    </div>
    {secret && <div className="token-secret" role="status">
      <div><Check size={15} /><strong>{t('token_shown_once')}</strong></div>
      <code>{secret}</code>
      <button onClick={() => void navigator.clipboard.writeText(secret).then(() => notify(t('token_copied'))).catch((error) => reportError(String(error)))}>
        <Copy size={15} />{t('copy_token')}
      </button>
      <code>{codexConfig}</code>
      <button onClick={() => void navigator.clipboard.writeText(codexConfig).then(() => notify(t('codex_copied'))).catch((error) => reportError(String(error)))}>
        <Copy size={15} />{t('copy_codex_config')}
      </button>
    </div>}
    <form className="token-form" onSubmit={(event) => {
      event.preventDefault();
      void create();
    }}>
      <label>{t('name')}<input required maxLength={40} placeholder={t('token_placeholder')} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t('access')}<select value={access} onChange={(event) => setAccess(event.target.value as IntegrationToken['access'])}>
        <option value="read-write">{t('read_and_write')}</option>
        <option value="read">{t('read_only')}</option>
      </select></label>
      <label>{t('expiration')}<select value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)}>
        <option value={30}>{t('days_30')}</option>
        <option value={90}>{t('days_90')}</option>
        <option value={365}>{t('days_365')}</option>
        <option value="permanent">{t('permanent')}</option>
      </select></label>
      <button className="primary" disabled={disabled || working || !name.trim()}>
        {working ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{t('create_token')}
      </button>
    </form>
    <div className="token-list" aria-label={t('ai_access')}>
      {loading ? <div className="token-empty">{t('loading_tokens')}</div> :
        !tokens.length ? <div className="token-empty">{t('no_active_tokens')}</div> :
          tokens.map((item) => <div className="token-row" key={item.id}>
            <div><strong>{item.name}</strong><span>{item.access === 'read-write' ? t('read_and_write') : t('read_only')} · {expiry(item.expiresAt)}</span></div>
            {confirmRevoke === item.id ? <div className="token-actions">
              <button className="danger" disabled={working} onClick={() => void revoke(item.id)}><Trash2 size={14} />{t('confirm_revoke')}</button>
              <button aria-label={t('cancel_revoke')} disabled={working} onClick={() => setConfirmRevoke('')}><X size={14} /></button>
            </div> :
              <button className="icon-button" title={t('revoke_token')} aria-label={item.name} disabled={disabled || working} onClick={() => setConfirmRevoke(item.id)}><Trash2 size={16} /></button>}
          </div>)}
    </div>
  </section>;
}
