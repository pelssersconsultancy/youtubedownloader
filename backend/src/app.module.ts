import { Module } from '@nestjs/common';
import { VideosController } from './videos.controller.ts';
import { VideosService } from './videos.service.ts';
import { AppStorage } from './app-storage.ts';
import { YtdlpRunner } from './yt-dlp-runner.ts';
import { ChannelService } from './channel.service.ts';

@Module({ controllers: [VideosController], providers: [VideosService, AppStorage, YtdlpRunner, ChannelService] })
export class AppModule {}
