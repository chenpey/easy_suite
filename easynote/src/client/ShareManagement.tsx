import { useEffect, useState } from 'react';
import { CalendarPlus, FileText, Infinity as InfinityIcon, LoaderCircle, Trash2 } from 'lucide-react';
import type { ManagedNoteShare } from '../shared/types';
import { api } from './api';
import { dateLocale, t } from './i18n';

interface Props {
  disabled: boolean;
  notify(message: string): void;
  openNote(share: ManagedNoteShare): void;
  reportError(message: string): void;
}

const dateTime = (value: number) => new Date(value).toLocaleString(dateLocale(), {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function ShareManagement({ disabled, notify, openNote, reportError }: Props) {
  const [shares, setShares] = useState<ManagedNoteShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState('');
  const [extensions, setExtensions] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    void api.noteShares()
      .then((result) => { if (active) setShares(result.shares); })
      .catch((error: unknown) => reportError(String(error)))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reportError]);

  const extend = async (item: ManagedNoteShare) => {
    const selected = extensions[item.noteId] ?? '168';
    setWorkingId(item.noteId);
    try {
      const result = await api.extendNoteShare(
        item.noteId,
        selected === 'permanent' ? null : Number(selected),
      );
      setShares((current) => current.map((share) =>
        share.noteId === item.noteId ? { ...share, ...result.share } : share));
      notify(selected === 'permanent' ? t('share_permanent_set') : t('share_extended'));
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorkingId('');
    }
  };

  const revoke = async (item: ManagedNoteShare) => {
    setWorkingId(item.noteId);
    try {
      await api.revokeNoteShare(item.noteId);
      setShares((current) => current.filter((share) => share.noteId !== item.noteId));
      notify(t('share_cancelled'));
    } catch (error) {
      reportError(String(error));
    } finally {
      setWorkingId('');
    }
  };

  return <div className="share-management">
    {loading ? <div className="panel-empty"><LoaderCircle className="spin" size={16} />{t('share_reading')}</div>
      : !shares.length ? <div className="panel-empty">{t('no_shared_notes')}</div>
        : <div className="share-management-list">
          {shares.map((item) => {
            const working = workingId === item.noteId;
            return <section className="share-management-row" key={item.noteId}>
              <div className="share-management-main">
                <button className="share-management-note" onClick={() => openNote(item)}>
                  <FileText size={16} />
                  <strong>{item.title || '未命名笔记'}</strong>
                </button>
                <span>
                  {item.archived ? `${t('archive')} · ` : ''}{t('share_shared_at', dateTime(item.createdAt))} · {item.expiresAt === null
                    ? t('never_expires')
                    : t('share_until', dateTime(item.expiresAt))}
                </span>
              </div>
              <div className="share-management-actions">
                {item.expiresAt === null
                  ? <span className="share-permanent"><InfinityIcon size={14} />{t('permanent')}</span>
                  : <>
                    <select aria-label={t('share_extend_duration_aria', item.title || '未命名笔记')}
                      value={extensions[item.noteId] ?? '168'}
                      disabled={disabled || working}
                      onChange={(event) => setExtensions((current) => ({
                        ...current,
                        [item.noteId]: event.target.value,
                      }))}>
                      <option value="24">{t('延长 1 天')}</option>
                      <option value="168">{t('延长 7 天')}</option>
                      <option value="720">{t('延长 30 天')}</option>
                      <option value="permanent">{t('设为永久')}</option>
                    </select>
                    <button aria-label={t('share_extend_aria', item.title || '未命名笔记')} disabled={disabled || working}
                      onClick={() => void extend(item)}>
                      {working ? <LoaderCircle className="spin" size={15} /> : <CalendarPlus size={15} />}{t('extend')}
                    </button>
                  </>}
                <button className="danger" aria-label={t('share_cancel_aria', item.title || '未命名笔记')}
                  disabled={disabled || working} onClick={() => void revoke(item)}>
                  {working ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{t('stop_sharing')}
                </button>
              </div>
            </section>;
          })}
        </div>}
  </div>;
}
