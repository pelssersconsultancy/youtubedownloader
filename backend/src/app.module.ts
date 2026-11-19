import { Module } from '@nestjs/common';
import { VideosController } from './videos.controller.ts';
import { VideosService } from './videos.service.ts';
import { AppStorage } from './app-storage.ts';

@Module({ controllers: [VideosController], providers: [VideosService, AppStorage] })
export class AppModule {}
