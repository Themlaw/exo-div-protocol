import { Module } from '@nestjs/common';
import { InternalStorageEventsController } from './internal_storage_events.controller';

@Module({ controllers: [InternalStorageEventsController] })
export class InternalStorageModule {}
