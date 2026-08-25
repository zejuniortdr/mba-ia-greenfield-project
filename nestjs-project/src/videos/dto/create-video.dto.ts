import {
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @MaxLength(100)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @IsPositive()
  sizeBytes: number;

  @IsOptional()
  @IsString()
  @Matches(/^video\/[\w.+-]+$/, {
    message: 'mimeType must be a video mime type',
  })
  mimeType?: string;
}
