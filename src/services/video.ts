import { config } from '../utils/config';
import ffmpegPath from 'ffmpeg-static';
import { unlink } from 'node:fs/promises';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface VideoData {
  data: string; // base64 encoded video
  mimeType: string;
}

interface ProcessedVideo {
  uri: string;
  mimeType: string;
  inlineData: boolean;
}

// Calculate max video size from config (converted to bytes)
const getMaxVideoSize = () => config.video.maxSizeMB * 1024 * 1024;

/**
 * Service for handling video content for Gemini API
 * Gemini 3 models support native video understanding via inline base64 data
 * 
 * NOTE: We use inline base64 encoding instead of the File API because:
 * 1. The File API requires special resumable upload protocol (x-goog-upload-url headers)
 * 2. Most proxies (like llm.prolix.dev) don't support this proprietary protocol
 * 3. Inline data works through any standard HTTP proxy
 */
export class VideoService {
  /**
   * Check if video service is available (Gemini API key is configured)
   */
  isAvailable(): boolean {
    return config.gemini.enabled;
  }

  /**
   * Download video from URL (Discord CDN) and encode as base64
   * If video exceeds max size (default 50MB), compress it using configurable settings
   * Returns the video data for inline use in Gemini requests
   */
  async processVideo(videoUrl: string, mimeType?: string): Promise<ProcessedVideo | null> {
    if (!config.gemini.enabled) {
      console.error('❌ [VIDEO] Gemini API key not configured');
      return null;
    }

    if (!ffmpegPath) {
      console.error('❌ [VIDEO] FFmpeg binary not found. Please install ffmpeg-static.');
      return null;
    }

    // Handle GIFs separately - convert to WebM
    if (mimeType?.startsWith('image/gif')) {
      console.log(`🎬 [VIDEO] Detected GIF, routing to GIF converter...`);
      return this.convertGifToVideo(videoUrl);
    }

    let tempDir: string | undefined;
    let inputPath: string | undefined;
    let outputPath: string | undefined;

    try {
      console.log(`🎥 [VIDEO] Downloading video from Discord CDN...`);
      
      // Download video from Discord CDN
      const response = await fetch(videoUrl);
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
      }

      // Get the actual MIME type from response or use provided one
      const contentType = response.headers.get('content-type') || mimeType || 'video/mp4';
      let videoBuffer = Buffer.from(await response.arrayBuffer());
      
      console.log(`🎥 [VIDEO] Downloaded ${videoBuffer.length} bytes (${contentType})`);
      
      // Check if compression is needed
      const maxVideoSize = getMaxVideoSize();
      if (videoBuffer.length > maxVideoSize) {
        console.log(`📦 [VIDEO] Video exceeds ${config.video.maxSizeMB}MB (${(videoBuffer.length / 1024 / 1024).toFixed(2)}MB), compressing...`);
        
        // Create temp directory
        tempDir = await mkdtemp(join(tmpdir(), 'lumia-video-'));
        inputPath = join(tempDir, 'input.mp4');
        outputPath = join(tempDir, 'output.mp4');
        
        // Write input file
        await writeFile(inputPath, videoBuffer);
        console.log(`📦 [VIDEO] Written input to temp file: ${inputPath}`);
        
        // Compress video using FFmpeg with configurable settings
        // Use conditional scaling to only scale down, never up
        const targetRes = config.video.targetResolution;
        const crf = config.video.crf;
        console.log(`📦 [VIDEO] Compressing to max ${targetRes}p with CRF ${crf}...`);
        
        const startTime = Date.now();
        // Scale filter: only scale if input height >= target, otherwise keep original
        const scaleFilter = `scale='if(gte(ih,${targetRes}),-2,iw)':'if(gte(ih,${targetRes}),${targetRes},ih)'`;
        const { exitCode, stderr } = await Bun.$`
          "${ffmpegPath}" -hide_banner -loglevel error -i "${inputPath}" \
            -c:v libx264 -crf ${crf} -preset fast \
            -vf "${scaleFilter},fps=30" \
            -c:a aac -b:a 128k \
            -movflags +faststart \
            -y "${outputPath}" 2>&1
        `;
        
        const duration = Date.now() - startTime;
        
        if (exitCode !== 0) {
          console.error(`❌ [VIDEO] FFmpeg compression failed:`, stderr.toString());
          return null;
        }
        
        console.log(`✅ [VIDEO] Compression completed in ${duration}ms`);
        
        // Read compressed video
        const compressedFile = Bun.file(outputPath);
        const compressedBuffer = Buffer.from(await compressedFile.arrayBuffer());
        
        const originalSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(2);
        const compressedSizeMB = (compressedBuffer.length / 1024 / 1024).toFixed(2);
        const reduction = (((videoBuffer.length - compressedBuffer.length) / videoBuffer.length) * 100).toFixed(1);
        
        console.log(`📦 [VIDEO] Compressed: ${originalSizeMB}MB → ${compressedSizeMB}MB (${reduction}% reduction)`);
        
        if (compressedBuffer.length > maxVideoSize) {
          console.warn(`⚠️  [VIDEO] Compressed video still exceeds ${config.video.maxSizeMB}MB (${compressedSizeMB}MB), skipping...`);
          return null;
        }
        
        videoBuffer = compressedBuffer;
      }
      
      console.log(`🎥 [VIDEO] Encoding video as base64 for inline transmission...`);
      
      // Encode as base64 for inline transmission
      const base64Data = videoBuffer.toString('base64');
      
      console.log(`✅ [VIDEO] Video ready for inline transmission (${base64Data.length} chars base64, ${(videoBuffer.length / 1024 / 1024).toFixed(2)}MB)`);

      return {
        uri: `data:${contentType};base64,${base64Data}`,
        mimeType: contentType,
        inlineData: true,
      };
    } catch (error) {
      console.error('❌ [VIDEO] Error processing video:', error);
      return null;
    } finally {
      // Clean up temp files
      if (tempDir) {
        try {
          if (inputPath) await unlink(inputPath).catch(() => {});
          if (outputPath) await unlink(outputPath).catch(() => {});
          console.log(`🧹 [VIDEO] Cleaned up temp files`);
        } catch (cleanupError) {
          console.error('⚠️  [VIDEO] Failed to clean up temp files:', cleanupError);
        }
      }
    }
  }

  /**
   * Process multiple videos
   */
  async processVideos(videos: { url: string; mimeType?: string }[]): Promise<ProcessedVideo[]> {
    const results: ProcessedVideo[] = [];
    
    for (const video of videos) {
      const processed = await this.processVideo(video.url, video.mimeType);
      if (processed) {
        results.push(processed);
      }
    }
    
    return results;
  }

  /**
   * Check if a MIME type is a supported video format
   */
  isSupportedVideoType(mimeType: string): boolean {
    const supportedTypes = [
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'video/x-msvideo',
      'video/x-matroska',
      'video/mov',
      'image/gif', // GIFs are converted to WebM
    ];
    return supportedTypes.some(type => mimeType.toLowerCase().startsWith(type));
  }

  /**
   * Convert animated GIF to WebM video for better LLM processing
   * WebM is smaller, higher quality, and better supported than GIF for video understanding
   * 
   * IMPROVED: Added input validation, timeout handling, and fallback codec support
   */
  async convertGifToVideo(gifUrl: string): Promise<ProcessedVideo | null> {
    const startTime = Date.now();
    
    if (!config.gemini.enabled) {
      console.error('❌ [GIF] Gemini API key not configured');
      return null;
    }

    if (!ffmpegPath) {
      console.error('❌ [GIF] FFmpeg binary not found. Please install ffmpeg-static.');
      return null;
    }

    let tempDir: string | undefined;
    let inputPath: string | undefined;
    let outputPath: string | undefined;
    let useFallbackCodec = false;

    try {
      console.log(`🎬 [GIF] Starting GIF conversion process...`);
      console.log(`🎬 [GIF] Downloading GIF from Discord CDN: ${gifUrl.substring(0, 50)}...`);
      
      // Download GIF from Discord CDN with timeout
      const downloadController = new AbortController();
      const downloadTimeout = setTimeout(() => downloadController.abort(), 30000); // 30 second timeout
      
      let response: Response;
      try {
        response = await fetch(gifUrl, { signal: downloadController.signal });
        clearTimeout(downloadTimeout);
      } catch (error) {
        clearTimeout(downloadTimeout);
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('GIF download timed out after 30 seconds');
        }
        throw error;
      }
      
      if (!response.ok) {
        throw new Error(`Failed to download GIF: ${response.status} ${response.statusText}`);
      }

      let gifBuffer = Buffer.from(await response.arrayBuffer());
      const originalSizeMB = (gifBuffer.length / 1024 / 1024).toFixed(2);
      
      console.log(`🎬 [GIF] Downloaded ${gifBuffer.length} bytes (${originalSizeMB}MB)`);
      
      // Validate GIF size
      const maxVideoSize = getMaxVideoSize();
      const maxGifSize = maxVideoSize * 3; // Allow GIFs up to 3x the video limit before conversion
      
      if (gifBuffer.length > maxGifSize) {
        console.error(`❌ [GIF] GIF is too large: ${originalSizeMB}MB (max allowed: ${(maxGifSize / 1024 / 1024).toFixed(0)}MB)`);
        return null;
      }
      
      if (gifBuffer.length > maxVideoSize * 2) {
        console.warn(`⚠️  [GIF] GIF is very large (${originalSizeMB}MB), conversion may take time...`);
      }
      
      // Validate minimum size (prevents corrupted/empty files)
      if (gifBuffer.length < 100) {
        console.error(`❌ [GIF] GIF is too small (${gifBuffer.length} bytes), likely corrupted`);
        return null;
      }
      
      // Create temp directory
      tempDir = await mkdtemp(join(tmpdir(), 'lumia-gif-'));
      inputPath = join(tempDir, 'input.gif');
      outputPath = join(tempDir, 'output.webm');
      
      // Write input file
      await writeFile(inputPath, gifBuffer);
      console.log(`📦 [GIF] Written input to temp file: ${inputPath}`);
      
      // First, try to probe the GIF to validate it's a proper animated GIF
      try {
        console.log(`🔍 [GIF] Validating GIF format...`);
        const probePromise = Bun.$`
          "${ffmpegPath}" -hide_banner -i "${inputPath}" 2>&1 | head -20
        `;
        
        // Add timeout using Promise.race
        const probeResult = await Promise.race([
          probePromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Probe timeout')), 10000))
        ]) as { exitCode: number; stdout: Buffer };
        
        if (probeResult.exitCode !== 0 && !probeResult.stdout.toString().includes('Stream')) {
          console.error(`❌ [GIF] Invalid GIF format or FFmpeg cannot read file`);
          return null;
        }
        
        const probeOutput = probeResult.stdout.toString();
        const isAnimated = probeOutput.includes('Video: gif');
        
        if (!isAnimated) {
          console.warn(`⚠️  [GIF] File may not be a proper animated GIF, attempting conversion anyway...`);
        } else {
          console.log(`✅ [GIF] Validated GIF format`);
        }
      } catch (probeError) {
        if (probeError instanceof Error && probeError.message === 'Probe timeout') {
          console.warn(`⚠️  [GIF] GIF validation timed out, continuing anyway...`);
        } else {
          console.warn(`⚠️  [GIF] Could not validate GIF format, continuing anyway: ${probeError}`);
        }
      }
      
      // Convert GIF to WebM using FFmpeg
      // STRATEGY: Try VP9 first (better compression), fall back to H.264 if it fails
      const targetRes = config.video.targetResolution;
      let crf = Math.min(config.video.crf + 5, 35); // Slightly higher CRF for GIFs
      let conversionSuccessful = false;
      let attemptCount = 0;
      const maxAttempts = 2; // VP9 attempt + H.264 fallback
      
      while (!conversionSuccessful && attemptCount < maxAttempts) {
        attemptCount++;
        useFallbackCodec = attemptCount > 1;
        
        const codec = useFallbackCodec ? 'libx264' : 'libvpx-vp9';
        const outputExt = useFallbackCodec ? 'mp4' : 'webm';
        outputPath = join(tempDir, `output.${outputExt}`);
        
        console.log(`📦 [GIF] Conversion attempt ${attemptCount}/${maxAttempts}: Using ${codec} codec...`);
        
        const conversionStartTime = Date.now();
        
        // Build FFmpeg command based on codec
        let ffmpegCommand: string;
        const scaleFilter = `scale='if(gte(ih,${targetRes}),-2,iw)':'if(gte(ih,${targetRes}),${targetRes},ih)':flags=lanczos`;
        
        if (useFallbackCodec) {
          // H.264 fallback (faster, more compatible)
          ffmpegCommand = `"${ffmpegPath}" -hide_banner -loglevel error -i "${inputPath}" -c:v libx264 -crf ${crf} -preset fast -vf "${scaleFilter},fps=30" -movflags +faststart -pix_fmt yuv420p -y "${outputPath}" 2>&1`;
        } else {
          // VP9 primary (better compression)
          ffmpegCommand = `"${ffmpegPath}" -hide_banner -loglevel error -i "${inputPath}" -c:v libvpx-vp9 -crf ${crf} -b:v 0 -vf "${scaleFilter},fps=30" -deadline good -cpu-used 2 -auto-alt-ref 0 -y "${outputPath}" 2>&1`;
        }
        
        try {
          const conversionTimeout = 60000; // 60 second timeout per attempt
          
          // Use Promise.race for timeout since Bun shell doesn't have native timeout
          const conversionPromise = Bun.$`${ffmpegCommand}`;
          const conversionResult = await Promise.race([
            conversionPromise,
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Conversion timeout')), conversionTimeout)
            )
          ]) as { exitCode: number; stderr: Buffer };
          
          const conversionDuration = Date.now() - conversionStartTime;
          
          if (conversionResult.exitCode === 0) {
            console.log(`✅ [GIF] Conversion completed in ${conversionDuration}ms using ${codec}`);
            conversionSuccessful = true;
          } else {
            const errorMsg = conversionResult.stderr.toString();
            console.error(`❌ [GIF] ${codec} conversion failed:`, errorMsg.substring(0, 500));
            
            if (attemptCount < maxAttempts) {
              console.log(`🔄 [GIF] Retrying with fallback codec...`);
              crf = Math.min(crf + 5, 40); // Increase compression for fallback
            } else {
              console.error(`❌ [GIF] All conversion attempts failed`);
              return null;
            }
          }
        } catch (timeoutError) {
          if (timeoutError instanceof Error && timeoutError.message === 'Conversion timeout') {
            console.error(`⏱️  [GIF] Conversion timed out after 60 seconds`);
          } else {
            console.error(`❌ [GIF] Conversion error:`, timeoutError);
          }
          
          if (attemptCount < maxAttempts) {
            console.log(`🔄 [GIF] Retrying with faster codec...`);
            crf = Math.min(crf + 5, 40);
          } else {
            console.error(`❌ [GIF] All conversion attempts failed`);
            return null;
          }
        }
      }
      
      if (!conversionSuccessful || !outputPath) {
        console.error(`❌ [GIF] Conversion failed after ${attemptCount} attempts`);
        return null;
      }
      
      // Read converted video
      const outputFile = Bun.file(outputPath);
      let outputBuffer = Buffer.from(await outputFile.arrayBuffer());
      
      const outputSizeMB = (outputBuffer.length / 1024 / 1024).toFixed(2);
      const mimeType = useFallbackCodec ? 'video/mp4' : 'video/webm';
      const reduction = (((gifBuffer.length - outputBuffer.length) / gifBuffer.length) * 100).toFixed(1);
      
      console.log(`📦 [GIF] Converted: ${originalSizeMB}MB → ${outputSizeMB}MB (${reduction}% reduction) [${mimeType}]`);
      
      // If still too large, re-encode with higher compression
      if (outputBuffer.length > maxVideoSize) {
        console.log(`📦 [GIF] Output exceeds ${config.video.maxSizeMB}MB, re-encoding with higher compression...`);
        
        const highCompressionPath = join(tempDir, `output_compressed.${useFallbackCodec ? 'mp4' : 'webm'}`);
        const fallbackRes = 480;
        const fallbackScaleFilter = `scale='if(gte(ih,${fallbackRes}),-2,iw)':'if(gte(ih,${fallbackRes}),${fallbackRes},ih)':flags=lanczos`;
        const fallbackCrf = useFallbackCodec ? 28 : 40;
        
        try {
          let reencodeCommand: string;
          
          if (useFallbackCodec) {
            reencodeCommand = `"${ffmpegPath}" -hide_banner -loglevel error -i "${outputPath}" -c:v libx264 -crf ${fallbackCrf} -preset fast -vf "${fallbackScaleFilter},fps=24" -movflags +faststart -pix_fmt yuv420p -y "${highCompressionPath}" 2>&1`;
          } else {
            reencodeCommand = `"${ffmpegPath}" -hide_banner -loglevel error -i "${outputPath}" -c:v libvpx-vp9 -crf ${fallbackCrf} -b:v 0 -vf "${fallbackScaleFilter},fps=24" -deadline good -cpu-used 4 -auto-alt-ref 0 -y "${highCompressionPath}" 2>&1`;
          }
          
          // Use Promise.race for timeout
          const reencodePromise = Bun.$`${reencodeCommand}`;
          const reencodeResult = await Promise.race([
            reencodePromise,
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Re-encode timeout')), 60000)
            )
          ]) as { exitCode: number; stderr: Buffer };
          
          if (reencodeResult.exitCode === 0) {
            const compressedFile = Bun.file(highCompressionPath);
            const compressedBuffer = Buffer.from(await compressedFile.arrayBuffer());
            const compressedSizeMB = (compressedBuffer.length / 1024 / 1024).toFixed(2);
            
            console.log(`✅ [GIF] Re-encoded: ${outputSizeMB}MB → ${compressedSizeMB}MB`);
            
            if (compressedBuffer.length <= maxVideoSize) {
              outputBuffer = compressedBuffer;
              outputPath = highCompressionPath;
            } else {
              console.warn(`⚠️  [GIF] Even compressed version exceeds ${config.video.maxSizeMB}MB (${compressedSizeMB}MB), skipping...`);
              await unlink(highCompressionPath).catch(() => {});
              return null;
            }
          } else {
            console.error(`❌ [GIF] Re-encoding failed:`, reencodeResult.stderr.toString().substring(0, 500));
          }
        } catch (reencodeError) {
          if (reencodeError instanceof Error && reencodeError.message === 'Re-encode timeout') {
            console.error(`⏱️  [GIF] Re-encoding timed out after 60 seconds`);
          } else {
            console.error(`❌ [GIF] Re-encoding error:`, reencodeError);
          }
        }
      }
      
      // Final validation
      if (outputBuffer.length < 100) {
        console.error(`❌ [GIF] Output file is too small (${outputBuffer.length} bytes), likely corrupted`);
        return null;
      }
      
      console.log(`🎬 [GIF] Encoding as base64 for inline transmission...`);
      
      // Encode as base64 for inline transmission
      const base64Data = outputBuffer.toString('base64');
      
      const totalDuration = Date.now() - startTime;
      console.log(`✅ [GIF] Successfully converted GIF in ${totalDuration}ms (${base64Data.length} chars base64, ${(outputBuffer.length / 1024 / 1024).toFixed(2)}MB)`);

      return {
        uri: `data:${mimeType};base64,${base64Data}`,
        mimeType: mimeType,
        inlineData: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ [GIF] Error converting GIF: ${errorMessage}`);
      
      // Log additional diagnostics
      if (errorMessage.includes('timeout')) {
        console.error(`⏱️  [GIF] This was a timeout error. The GIF may be too large or complex.`);
      }
      
      return null;
    } finally {
      // Clean up temp files
      if (tempDir) {
        try {
          if (inputPath) await unlink(inputPath).catch((e) => console.warn(`⚠️  [GIF] Failed to clean up input: ${e}`));
          if (outputPath) await unlink(outputPath).catch((e) => console.warn(`⚠️  [GIF] Failed to clean up output: ${e}`));
          console.log(`🧹 [GIF] Cleaned up temp files`);
        } catch (cleanupError) {
          console.error('⚠️  [GIF] Failed to clean up temp files:', cleanupError);
        }
      }
    }
  }
}

export const videoService = new VideoService();
