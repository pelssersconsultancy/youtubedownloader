import { Module } from '@nestjs/common';
import { VideosController } from './videos.controller.ts';
import { VideosService } from './videos.service.ts';

@Module({ controllers: [VideosController], providers: [VideosService] })
export class AppModule {}
