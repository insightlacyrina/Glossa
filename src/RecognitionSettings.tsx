import { useEffect, useState } from 'react';
import { nativeRequest } from './native';
import type { useWorkspace } from './useWorkspace';

export function RecognitionSettings({
  workspace: w,
}: {
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const [language, setLanguage] = useState(
    String(w.engine?.state.settings.recognitionLanguage ?? 'zh-Hans'),
  );
  const [downloaded, setDownloaded] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [check, setCheck] = useState(0);
  const available = Boolean(window.QuietPaperNative?.getRecognitionStatus);
  useEffect(() => {
    let current = true;
    setDownloaded(undefined);
    setMessage('');
    if (available)
      void nativeRequest('getRecognitionStatus', [language])
        .then((reply) => {
          if (current) setDownloaded(reply.downloaded);
        })
        .catch((error) => {
          if (current) setMessage(error.message);
        });
    return () => {
      current = false;
    };
  }, [available, language, check]);
  async function run(download: boolean) {
    setBusy(true);
    setMessage('');
    try {
      if (download) {
        await nativeRequest('downloadRecognitionModel', [language]);
        setDownloaded(true);
      }
      await w.retryRecognition();
      setMessage('已重新处理原稿，识别候选请到“校对”核对。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="dialog-stack">
      <p>
        手写优先使用本机数字笔迹模型，图片使用内置中英文文字识别。识别结果保留为校对候选，原始笔迹持续保留。
      </p>
      {available ? (
        <>
          <label>
            手写语言
            <select
              value={language}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value;
                if (w.transact((engine) => engine.setSetting('recognitionLanguage', next)))
                  setLanguage(next);
              }}
            >
              <option value="zh-Hans">简体中文</option>
              <option value="zh-Hant">繁体中文</option>
              <option value="en-US">English</option>
            </select>
          </label>
          <p>
            {downloaded === undefined
              ? '正在检查手写模型…'
              : downloaded
                ? '手写模型已就绪，可离线识别。'
                : '首次使用需下载所选语言的手写模型。下载不包含笔记内容。'}
            图片模型随安装包提供。
          </p>
          {downloaded === undefined && message && (
            <button type="button" className="button" onClick={() => setCheck((value) => value + 1)}>
              重新检查模型
            </button>
          )}
          {w.role === 'tablet' && (
            <div className="button-row">
              <button
                type="button"
                className="button"
                disabled={busy || downloaded === undefined}
                onClick={() => void run(!downloaded)}
              >
                {busy ? '正在处理…' : downloaded ? '重新识别原稿' : '下载模型并识别'}
              </button>
            </div>
          )}
        </>
      ) : (
        <p>
          本机手写识别由 Android 安装包提供。浏览器可在“外部模型”中授权视觉模型；Mac
          阅读端继续保留原稿编辑权限限制。
        </p>
      )}
      <p>
        仿手写使用你确认过的字形笔迹。在平板原稿上框选一个字的全部笔画，选择“学习选中字形”。
        文字修订缺少字形或空间不足时保留印刷层，补充字形后可在“修订与历史”重试。
      </p>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
