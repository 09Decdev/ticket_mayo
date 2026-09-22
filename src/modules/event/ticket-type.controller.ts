import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AdminAuthGuard } from '../../common/guards/jwt-auth.guard';
import { EventService } from './event.service';
import {
  CreateTicketTypeDto,
  UpdateTicketTypeAppearanceDto,
  UpdateTicketTypeBasicDto,
} from './dtos/create-ticket-type.dto';
import { UpdateTicketTypeDto } from './dtos/update-ticket-type.dto';

/** Multer file shape (multer 2.x nằm transitively trong @nestjs/platform-express;
 *  KHÔNG khai @types/multer — dùng structural type, đủ 4 field service cần). */
interface MulterFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

@ApiTags('admin/ticket-types')
@Controller('admin/ticket-types')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth('JWT-auth')
export class TicketTypeController {
  constructor(private readonly eventService: EventService) {}

  @Get()
  @ApiOperation({ summary: 'List ticket types (optionally filtered by eventId)' })
  @ApiQuery({ name: 'eventId', required: false, type: String })
  list(@Query('eventId') eventId?: string) {
    return this.eventService.listTicketTypes(eventId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a ticket type' })
  create(@Body() dto: CreateTicketTypeDto) {
    return this.eventService.createTicketType(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a ticket type' })
  update(@Param('id') id: string, @Body() dto: UpdateTicketTypeDto) {
    return this.eventService.updateTicketType(id, dto);
  }

  @Get(':id/basic')
  @ApiOperation({ summary: 'Get one ticket type for edit screen (name/quantity/sold)' })
  getForEdit(@Param('id') id: string) {
    return this.eventService.getTicketTypeForEdit(id);
  }

  @Patch(':id/basic')
  @ApiOperation({
    summary:
      'Update ticket type basic info (name + quantity only) — content validate quantity >= sold',
  })
  updateBasic(@Param('id') id: string, @Body() dto: UpdateTicketTypeBasicDto) {
    return this.eventService.updateTicketTypeBasic(id, dto);
  }

  // DELETE-INTERNAL: xóa loại vé — content hard-delete + AuditLog, chỉ khi
  // sold = 0. sold > 0 → 400 TICKET_TYPE_HAS_SOLD_TICKETS kèm sold.
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a ticket type — chỉ khi chưa có vé được cấp (sold = 0)',
  })
  remove(@Param('id') id: string) {
    return this.eventService.deleteTicketType(id);
  }

  // ─── TICKET-APPEARANCE (admin "Ảnh vé & màu QR") ───
  @Get(':id/appearance')
  @ApiOperation({
    summary:
      'Get ticket type appearance (ảnh riêng + màu QR + event context) cho edit screen',
  })
  getAppearance(@Param('id') id: string) {
    return this.eventService.getTicketTypeAppearance(id);
  }

  @Patch(':id/appearance')
  @ApiOperation({
    summary:
      'Update ticket type appearance — ticketImageFileId (null = bỏ ảnh riêng) + màu QR hex',
  })
  updateAppearance(
    @Param('id') id: string,
    @Body() dto: UpdateTicketTypeAppearanceDto,
  ) {
    return this.eventService.updateTicketTypeAppearance(id, dto);
  }

  @Post(':id/appearance/image')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Ảnh vé (png/jpg/webp) — upload-service optimize → .webp',
        },
      },
      required: ['file'],
    },
  })
  @ApiOperation({
    summary:
      'Upload ảnh vé cho loại vé (upload-service) → trả fileId, CHƯA gắn vào loại vé (admin xem preview rồi bấm Lưu)',
  })
  uploadImage(@Param('id') id: string, @UploadedFile() file?: MulterFile) {
    if (!file || !file.buffer?.length) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Thiếu file ảnh (multipart field "file")',
        error: 'VALIDATION_ERROR',
      };
    }
    if (!/^image\//.test(file.mimetype)) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Chỉ nhận file ảnh (image/*)',
        error: 'VALIDATION_ERROR',
      };
    }
    if (file.size > 10 * 1024 * 1024) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Ảnh quá lớn (>10MB)',
        error: 'VALIDATION_ERROR',
      };
    }
    return this.eventService.uploadTicketTypeImage(id, file);
  }

  @Get(':id/appearance/image-proxy')
  @ApiOperation({
    summary:
      'Proxy presigned URL → bytes ảnh same-origin cho preview (tránh CORS SeaweedFS) — ?url=<presigned>',
  })
  async imageProxy(
    @Param('id') id: string,
    @Query('url') url: string,
    @Res() res: Response,
  ) {
    const { buffer, contentType } = await this.eventService.getTicketTypeImage(url);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.end(buffer);
  }
}
