import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { VideosService } from './videos.service.ts';

@Controller('api')
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  @Get('settings')
  settings() {
    return this.videos.getSettings();
  }

  @Post('settings')
  configure(@Body() body: { downloadDir?: string; maxParallelDownloads?: number; cookiesBrowser?: string; language?: string }) {
    return this.updateSettings(body ?? {});
  }

  private async updateSettings(body: { downloadDir?: string; maxParallelDownloads?: number; cookiesBrowser?: string; language?: string }) {
    if (body.downloadDir !== undefined && body.downloadDir.trim()) await this.videos.setDownloadDir(body.downloadDir);
    if (body.maxParallelDownloads !== undefined) await this.videos.setMaxParallelDownloads(body.maxParallelDownloads);
    if (body.cookiesBrowser !== undefined) await this.videos.setCookiesBrowser(body.cookiesBrowser);
    if (body.language !== undefined) await this.videos.setLanguage(body.language);
    return this.videos.getSettings();
  }

  @Patch('sync')
  setSync(@Body() body: { enabled?: boolean }) {
    return this.videos.setSyncEnabled(body?.enabled === true);
  }

  @Get('channels')
  channels() {
    return this.videos.getChannels();
  }

  @Get('suggestions')
  suggestions() {
    return this.videos.getSuggestions();
  }

  @Get('channels/progress')
  channelProgress() {
    return this.videos.getChannelProgress();
  }

  @Get('sync/failures')
  failureLog(@Query('lines') lines = '1000') {
    return this.videos.getFailureLog(Number(lines));
  }

  @Post('channels')
  addChannel(@Body() body: { url?: string }) {
    return this.videos.addChannel(body?.url ?? '');
  }

  @Patch('channels/autosync')
  autoSync(@Body() body: { url?: string; enabled?: boolean }) {
    return this.videos.setChannelAutoSync(body?.url ?? '', body?.enabled === true);
  }

  @Patch('channels/order')
  reorderChannels(@Body() body: { urls?: string[] }) {
    return this.videos.reorderChannels(body?.urls ?? []);
  }

  @Get('channels/videos')
  channelVideos(
    @Query('url') url = '',
    @Query('offset') offset = '0',
    @Query('limit') limit = '20',
  ) {
    return this.videos.getChannelVideoPage(url, Number(offset), Number(limit));
  }

  @Delete('channels')
  removeChannel(@Query('url') url: string) {
    return this.videos.removeChannel(url);
  }

  @Get('videos')
  search(
    @Query('q') query = '',
    @Query('offset') offset = '0',
    @Query('limit') limit = '20',
  ) {
    return this.videos.searchVideos(query, Number(offset), Number(limit));
  }

  @Get('videos/:id/play')
  async play(@Param('id') id: string, @Res() response: Response) {
    const path = await this.videos.getDownloadedVideoPath(id);
    return response.sendFile(path);
  }

  @Get('videos/:id/subtitles/:language')
  async subtitle(@Param('id') id: string, @Param('language') language: string, @Res() response: Response) {
    const path = await this.videos.getDownloadedSubtitlePath(id, language);
    return response.type('text/vtt').sendFile(path);
  }

  /** Lijst van alle video's van een kanaal (of afspeellijst). */
  @Get('channel')
  channel(@Query('url') url: string) {
    return this.videos.listChannel(url);
  }

  /** Gedownloade ids, wachtrij, huidige voortgang en mislukte downloads. */
  @Get('state')
  state() {
    return this.videos.getState();
  }

  @Post('download')
  download(@Body() body: { ids: string[] }) {
    return this.videos.enqueue(body?.ids ?? []);
  }
}

