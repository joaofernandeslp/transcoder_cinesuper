import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";

export function probeAndReplayFromReadable({
  inputReadable,
  ffprobePath,
  onLog
}) {
  return new Promise((resolve, reject) => {
    // Túnel para manter compatibilidade
    const replayStream = new PassThrough();
    
    const ffprobe = spawn(ffprobePath, [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      "-i", "pipe:0"
    ]);

    let jsonOutput = "";
    let errorLog = "";
    
    // --- LÓGICA DE CORTE MANUAL ---
    // Vamos contar quantos bytes enviamos pro FFprobe.
    // Chegou em 5MB? Manda o sinal de FIM (end) para ele parar de esperar.
    const MAX_PROBE_BYTES = 50 * 1024 * 1024; // 50MB de limite
    let bytesSent = 0;
    let probeClosed = false;

    // Função que alimenta o FFprobe manualmente
    const onData = (chunk) => {
        if (probeClosed) return; // Se já fechamos, ignora

        // Escreve no stdin do ffprobe
        const canWrite = ffprobe.stdin.write(chunk);
        bytesSent += chunk.length;

        // Se passamos do limite, cortamos o barato do ffprobe
        if (bytesSent >= MAX_PROBE_BYTES) {
            probeClosed = true;
            ffprobe.stdin.end(); // <--- O SEGREDO: Simula o fim do arquivo na força
            
            // Paramos de escutar o stream original para economizar CPU
            // (Nota: não destruímos o inputReadable caso você queira usar o replayStream depois)
            inputReadable.off('data', onData);
        }
    };

    // Conectamos manualmente em vez de usar .pipe()
    inputReadable.on('data', onData);

    // Tratamento de erros
    inputReadable.on("error", (e) => {
        if (!probeClosed && e.code !== 'EPIPE') console.error('[Stream Error]', e.message);
    });
    
    ffprobe.stdin.on("error", () => {
        // Se o ffprobe fechar antes dos 5MB, tudo bem, paramos de enviar
        probeClosed = true;
        inputReadable.off('data', onData);
    });

    ffprobe.stdout.on("data", (chunk) => {
      jsonOutput += chunk.toString();
    });

    ffprobe.stderr.on("data", (chunk) => {
      const msg = chunk.toString();
      errorLog += msg;
      if (onLog) onLog(msg);
    });

    ffprobe.on("close", (code) => {
      try {
        // Limpeza de JSON
        const firstBrace = jsonOutput.indexOf('{');
        const lastBrace = jsonOutput.lastIndexOf('}');
        
        if (firstBrace !== -1 && lastBrace !== -1) {
            jsonOutput = jsonOutput.substring(firstBrace, lastBrace + 1);
        }

        if (!jsonOutput) throw new Error("Saída vazia.");

        const data = JSON.parse(jsonOutput);
        
        resolve({
          probe: {
            width: getWidth(data),
            height: getHeight(data),
            videoCodec: getVideoCodec(data),
            format: data.format,
            streams: data.streams
          },
          replayStream // Retornamos, embora para probe via torrent geralmente descartamos depois
        });
      } catch (e) {
        reject(new Error(`FFprobe falhou. Code=${code}. Log: ${errorLog}`));
      }
    });

    ffprobe.on("error", (err) => {
      reject(new Error(`Erro spawn FFprobe: ${err.message}`));
    });
  });
}

// Helpers
function getWidth(data) {
  const v = data.streams?.find((s) => s.codec_type === "video");
  return v ? v.width : 0;
}

function getHeight(data) {
  const v = data.streams?.find((s) => s.codec_type === "video");
  return v ? v.height : 0;
}

function getVideoCodec(data) {
  const v = data.streams?.find((s) => s.codec_type === "video");
  return v ? v.codec_name : "unknown";
}