import { IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateEventDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  venue?: string;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  /**
   * EVENT-EDIT: sức chứa sự kiện (content maxParticipants). Content validate
   * maxParticipants >= số người đã đăng ký hiện tại — vi phạm → 400
   * EVENT_MAX_PARTICIPANTS_BELOW_REGISTERED kèm registeredCount trong payload.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  maxParticipants?: number;
}
