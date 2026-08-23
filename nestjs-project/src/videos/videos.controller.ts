import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { ChannelsService } from '../channels/channels.service';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  CompleteUploadResult,
  InitiateUploadResult,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
  ) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Creates a draft video in the authenticated user channel and starts a multipart upload, returning presigned PUT URLs per part.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        uploadId: { type: 'string' },
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 413,
    description: 'Video size exceeds the 10GB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(user.sub);
    if (!channel) {
      throw new Error(`No channel found for user ${user.sub}`);
    }
    return this.videosService.initiateUpload(channel.id, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload in storage, moves the video to processing, and enqueues background processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the authenticated user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload has already been completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const channel = await this.channelsService.findByUserId(user.sub);
    if (!channel) {
      throw new Error(`No channel found for user ${user.sub}`);
    }
    return this.videosService.completeUpload(id, channel.id, dto);
  }

  @Get(':id/stream-url')
  @Public()
  @ApiOperation({
    summary: 'Get a presigned streaming URL',
    description:
      'Returns a presigned GET URL (with Range support) for the video file. Public — no authentication required.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned streaming URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not complete yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamUrl(
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    return this.videosService.getStreamUrl(id);
  }

  @Get(':id/download-url')
  @Public()
  @ApiOperation({
    summary: 'Get a presigned download URL',
    description:
      'Returns a presigned GET URL with Content-Disposition: attachment for the video file. Public — no authentication required.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload is not complete yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadUrl(
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    return this.videosService.getDownloadUrl(id);
  }
}
