import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler"; // <--- Importante para performance
import https from "https"; 
import mime from "mime-types";

// --- CONFIGURAÇÃO DO R2 ---
const R2_BUCKET = "cinesuper-storage";
const R2_ENDPOINT = "https://6a07e1cc1b3be5e83613d9c0ff2a59c0.r2.cloudflarestorage.com";
const R2_ACCESS_KEY = "096a159e1227a245762633ccefbcc30f";
const R2_SECRET_KEY = "6e1eca863bbc5c9c0797e91bb1ad54c7a6cff94d15baaaa509a9bd485b973284";
// --------------------------

// 1. AGENTE HTTPS OTIMIZADO (KEEP-ALIVE)
// Mantém as conexões abertas para não perder tempo negociando SSL a cada arquivo
const agent = new https.Agent({
    maxSockets: 200, 
    keepAlive: true, 
});

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  // Injeta o agente turbo
  requestHandler: new NodeHttpHandler({
      httpsAgent: agent,
      connectionTimeout: 10000,
      socketTimeout: 10000
  }),
});

export function startLiveUpload(localFolder, cloudFolder) {
  console.log(`[R2] Monitorando (Modo Turbo 🚀): ${localFolder} -> ${cloudFolder}`);

  const queue = [];
  let activeUploads = 0;
  
  // AQUI ESTÁ O SEGREDO: 15 uploads ao mesmo tempo!
  const CONCURRENCY_LIMIT = 15; 

  const watcher = chokidar.watch(localFolder, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 1000, // Diminuí para 1s para ser mais ágil
      pollInterval: 100
    },
  });

  // --- GERENCIADOR DE FILA PARALELA ---
  const processQueue = () => {
    // Enquanto tiver espaço (menos de 15 rodando) e tiver arquivos na fila...
    while (activeUploads < CONCURRENCY_LIMIT && queue.length > 0) {
        const job = queue.shift();
        activeUploads++;
        
        // Dispara o upload e quando acabar, libera a vaga e chama o próximo
        handleUpload(job).finally(() => {
            activeUploads--;
            processQueue();
        });
    }
  };

  const handleUpload = async ({ filePath, retryCount = 0 }) => {
    const fileName = path.basename(filePath);
    const relativePath = path.relative(localFolder, filePath);
    const r2Key = path.join(cloudFolder, relativePath).split(path.sep).join('/');

    try {
      try { await fs.access(filePath); } catch { return; } // Arquivo já sumiu

      const fileStream = await fs.readFile(filePath);
      const contentType = mime.lookup(filePath) || 'application/octet-stream';

      const uploader = new Upload({
        client: s3,
        params: {
          Bucket: R2_BUCKET,
          Key: r2Key,
          Body: fileStream,
          ContentType: contentType
        },
        queueSize: 4, 
        partSize: 1024 * 1024 * 10, 
      });

      await uploader.done();
      console.log(`[R2] Upload sucesso: ${fileName}`);

      if (!fileName.endsWith('.m3u8') && !fileName.endsWith('init.mp4')) {
          try { await fs.unlink(filePath); } catch {} 
      }

    } catch (err) {
      // Retry Lógica (Mantive a segurança contra quedas)
      const isNetworkError = err.code === 'EPROTO' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.name === 'name';
      const isBusy = err.code === 'EBUSY';

      if ((isBusy || isNetworkError || err) && retryCount < 10) {
          const delay = isBusy ? 1000 : 2000;
          if(retryCount > 2) console.log(`[R2] Retentando ${fileName} (${retryCount}/10)...`);
          
          // Devolve pro fim da fila
          queue.push({ filePath, retryCount: retryCount + 1 });
          
          // Espera um pouco antes de processar de novo (não trava os outros uploads)
          await new Promise(r => setTimeout(r, delay));
      } else {
          console.error(`[R2 Error] Falha fatal: ${fileName}`);
      }
    }
  };

  watcher.on('add', (filePath) => { queue.push({ filePath }); processQueue(); });
  watcher.on('change', (filePath) => { queue.push({ filePath }); processQueue(); });

  return watcher;
}

// --- PENTE FINO OTIMIZADO (PARALELO) ---
export async function uploadDirectoryRecursive(localFolder, cloudFolder) {
  console.log('[R2] Iniciando varredura final...');
  
  async function walk(dir) {
    let list = [];
    try { list = await fs.readdir(dir); } catch { return; }

    // Cria um array de Promessas para subir tudo junto
    const uploadPromises = list.map(async (file) => {
        const filePath = path.join(dir, file);
        const stat = await fs.stat(filePath);
        
        if (stat.isDirectory()) {
            await walk(filePath);
        } else {
            const fileName = path.basename(filePath);
            if(fileName.startsWith('.')) return;

            const relativePath = path.relative(localFolder, filePath);
            const r2Key = path.join(cloudFolder, relativePath).split(path.sep).join('/');
            
            try {
                const fileStream = await fs.readFile(filePath);
                const uploader = new Upload({
                    client: s3,
                    params: { Bucket: R2_BUCKET, Key: r2Key, Body: fileStream, ContentType: mime.lookup(filePath) },
                });
                await uploader.done();
                console.log(`[R2 Final] Check: ${fileName}`);
            } catch (e) {
                 // Ignora erros leves no final sweep
            }
        }
    });
    
    // Espera todos da pasta subirem simultaneamente
    await Promise.all(uploadPromises);
  }

  await walk(localFolder);
  console.log('[R2] Varredura final concluída.');
}