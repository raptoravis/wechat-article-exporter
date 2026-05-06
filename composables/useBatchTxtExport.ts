import { formatElapsedTime } from '#shared/utils/helpers';
import toastFactory from '~/composables/toast';
import { articleDeleted, getArticleCache, updateArticleStatus } from '~/store/v2/article';
import { getHtmlCache } from '~/store/v2/html';
import type { MpAccount } from '~/store/v2/info';
import { Downloader } from '~/utils/download/Downloader';
import { Exporter } from '~/utils/download/Exporter';
import type { DownloaderStatus } from '~/utils/download/types';

type Phase = '准备中' | '下载中' | '导出中';

export default () => {
  const toast = toastFactory();

  const loading = ref(false);
  const phase = ref<Phase>('准备中');
  const completed_count = ref(0);
  const total_count = ref(0);

  let downloader: Downloader | null = null;

  async function batchExport(accounts: MpAccount[]) {
    if (accounts.length === 0) {
      toast.warning('提示', '请先选择公众号');
      return;
    }

    loading.value = true;
    phase.value = '准备中';
    completed_count.value = 0;
    total_count.value = 0;

    try {
      // 1. 收集每个公众号下需要导出的文章链接，并标记缺失 HTML 的链接
      const now = Math.floor(Date.now() / 1000);
      const plan: Array<{ fakeid: string; nickname: string; urls: string[] }> = [];
      const allUrls: string[] = [];
      const missingUrls: string[] = [];

      for (const account of accounts) {
        const articles = await getArticleCache(account.fakeid, now);
        const validArticles = articles.filter(a => !a.is_deleted);
        const urls = validArticles.map(a => a.link);

        plan.push({
          fakeid: account.fakeid,
          nickname: account.nickname || account.fakeid,
          urls,
        });

        for (const article of validArticles) {
          allUrls.push(article.link);
          const cache = await getHtmlCache(article.link);
          if (!cache) {
            missingUrls.push(article.link);
          }
        }
      }

      if (allUrls.length === 0) {
        toast.warning('提示', '所选公众号下没有可导出的文章，请先同步文章列表');
        return;
      }

      // 2. 提前让用户选择导出目录，避免下载完才弹窗造成困惑
      const exporter = new Exporter(allUrls);
      try {
        await exporter.acquireExportDirectoryHandle();
      } catch (e) {
        // 用户取消了目录选择
        return;
      }

      // 3. 下载缺失的 HTML 内容
      //    事件回调与单账号下载保持一致：把【正常/已删除/异常】状态回写到 db.article，
      //    避免批处理跑完后文章下载页看到的状态脏数据
      if (missingUrls.length > 0) {
        phase.value = '下载中';
        completed_count.value = 0;
        total_count.value = missingUrls.length;

        downloader = new Downloader(missingUrls);
        downloader.on('download:progress', (url: string, success: boolean, status: DownloaderStatus) => {
          completed_count.value = status.completed.length;
          if (success) {
            updateArticleStatus(url, '正常');
            articleDeleted(url, false);
          }
        });
        downloader.on('download:deleted', (url: string) => {
          updateArticleStatus(url, '已删除');
          articleDeleted(url);
        });
        downloader.on('download:exception', (url: string, msg: string) => {
          updateArticleStatus(url, msg);
        });

        try {
          await downloader.startDownload('html');
        } finally {
          downloader.removeAllListeners();
          downloader = null;
        }
      }

      // 4. 按账号分子目录导出 TXT
      phase.value = '导出中';
      completed_count.value = 0;
      total_count.value = 0;

      exporter.on('export:total', (total: number) => {
        total_count.value = total;
      });
      exporter.on('export:progress', (idx: number) => {
        completed_count.value = idx;
      });
      exporter.on('export:finish', (seconds: number) => {
        toast.success('一键导出完成', `共 ${accounts.length} 个公众号，耗时 ${formatElapsedTime(seconds)}`);
      });

      await exporter.startBatchTxtExport(plan);
    } catch (error) {
      console.error('一键导出失败:', error);
      toast.error('一键导出失败', (error as Error).message);
    } finally {
      loading.value = false;
    }
  }

  function stop() {
    if (downloader) {
      downloader.stop();
    }
  }

  return {
    loading,
    phase,
    completed_count,
    total_count,
    batchExport,
    stop,
  };
};
