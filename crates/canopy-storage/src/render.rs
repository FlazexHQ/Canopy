//! Image transformation bounds and codecs for the storage API.

use std::io::Cursor;

use canopy_protocol::CanopyError;
use canopy_protocol::sha256::sha256_hex;
use image::codecs::{avif::AvifEncoder, jpeg::JpegEncoder, png::PngEncoder};
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader};

/// The source byte and output dimension limits of the storage image API.
#[derive(Clone, Copy, Debug)]
pub struct ImageLimits {
    /// The largest output width or height, in pixels.
    pub max_dimension: u32,
    /// The largest encoded source, in bytes.
    pub max_source_size: u64,
}

impl Default for ImageLimits {
    fn default() -> Self {
        Self { max_dimension: 2500, max_source_size: 25 * 1024 * 1024 }
    }
}

const MAX_PIXELS: u64 = 50_000_000;
pub(crate) const MAX_VARIANTS: u64 = 25;
const FILTER: FilterType = FilterType::Lanczos3;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Origin,
    Jpeg,
    Png,
    Avif,
    Webp,
}

impl Format {
    fn name(self) -> &'static str {
        match self {
            Self::Origin => "origin",
            Self::Jpeg => "jpeg",
            Self::Png => "png",
            Self::Avif => "avif",
            Self::Webp => "webp",
        }
    }

    fn content_type(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Avif => "image/avif",
            Self::Webp => "image/webp",
            Self::Origin => "application/octet-stream",
        }
    }
}

#[derive(Clone, Copy)]
enum Resize {
    Cover,
    Contain,
    Fill,
}

impl Resize {
    fn name(self) -> &'static str {
        match self {
            Self::Cover => "cover",
            Self::Contain => "contain",
            Self::Fill => "fill",
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Transform {
    width: Option<u32>,
    height: Option<u32>,
    resize: Resize,
    quality: u8,
    format: Format,
}

fn whole(name: &str, value: &str, min: u32, max: u32) -> Result<u32, CanopyError> {
    if (1..=6).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && let Ok(value) = value.parse::<u32>()
        && (min..=max).contains(&value)
    {
        return Ok(value);
    }
    Err(CanopyError::invalid_query(format!("{name} must be a whole number from {min} to {max}")))
}

fn too_many_pixels() -> CanopyError {
    CanopyError::invalid_query(format!("Images of more than {MAX_PIXELS} pixels cannot be transformed"))
}

fn decode_error() -> CanopyError {
    CanopyError::invalid_query("The file is not an image that can be decoded")
}

fn avif_input() -> CanopyError {
    CanopyError::invalid_query("AVIF input is not supported")
}

pub(crate) fn check_source_size(size: u64, max: u64) -> Result<(), CanopyError> {
    if size > max {
        return Err(CanopyError::invalid_query(format!(
            "Images larger than {max} bytes cannot be transformed"
        )));
    }
    Ok(())
}

impl Transform {
    pub(crate) fn parse(param: impl Fn(&str) -> Option<String>, max: u32) -> Result<Self, CanopyError> {
        let resize = match param("resize").as_deref() {
            None | Some("cover") => Resize::Cover,
            Some("contain") => Resize::Contain,
            Some("fill") => Resize::Fill,
            _ => return Err(CanopyError::invalid_query("resize must be cover, contain or fill")),
        };
        let format = match param("format").as_deref() {
            None | Some("origin") => Format::Origin,
            Some("jpeg") => Format::Jpeg,
            Some("png") => Format::Png,
            Some("avif") => Format::Avif,
            Some("webp") => Format::Webp,
            _ => {
                return Err(CanopyError::invalid_query("format must be origin, webp, avif, jpeg or png"));
            }
        };
        Ok(Self {
            width: param("width").map(|value| whole("width", &value, 1, max)).transpose()?,
            height: param("height").map(|value| whole("height", &value, 1, max)).transpose()?,
            resize,
            quality: param("quality")
                .map(|value| whole("quality", &value, 20, 100))
                .transpose()?
                .unwrap_or(80) as u8,
            format,
        })
    }

    pub(crate) fn hash(self) -> String {
        let canonical = format!(
            "w{}_h{}_{}_q{}_{}",
            self.width.map(|value| value.to_string()).unwrap_or_default(),
            self.height.map(|value| value.to_string()).unwrap_or_default(),
            self.resize.name(),
            self.quality,
            self.format.name(),
        );
        sha256_hex(canonical.as_bytes())[..32].to_owned()
    }

    pub(crate) fn output(self, content_type: &str) -> Result<&'static str, CanopyError> {
        self.output_format(content_type).map(Format::content_type)
    }

    fn output_format(self, content_type: &str) -> Result<Format, CanopyError> {
        let origin = match content_type {
            "image/jpeg" => Format::Jpeg,
            "image/png" | "image/gif" | "image/bmp" => Format::Png,
            "image/webp" => Format::Webp,
            "image/avif" => return Err(avif_input()),
            _ => {
                return Err(CanopyError::invalid_query(
                    "Only JPEG, PNG, WebP, AVIF, GIF and BMP images can be transformed",
                ));
            }
        };
        let output = if self.format == Format::Origin { origin } else { self.format };
        if output == Format::Webp {
            return Err(CanopyError::invalid_query("Lossy WebP output is not supported"));
        }
        Ok(output)
    }

    pub(crate) fn encode(
        self,
        source: &[u8],
        content_type: &str,
        limits: ImageLimits,
    ) -> Result<Vec<u8>, CanopyError> {
        let format = self.output_format(content_type)?;
        let reader =
            ImageReader::new(Cursor::new(source)).with_guessed_format().map_err(|_| decode_error())?;
        match reader.format() {
            Some(ImageFormat::Avif) => return Err(avif_input()),
            Some(
                ImageFormat::Jpeg
                | ImageFormat::Png
                | ImageFormat::Gif
                | ImageFormat::Bmp
                | ImageFormat::WebP,
            ) => {}
            _ => return Err(decode_error()),
        }
        let mut decoder = reader.into_decoder().map_err(|_| decode_error())?;
        let (width, height) = decoder.dimensions();
        if width == 0 || height == 0 {
            return Err(decode_error());
        }
        if u64::from(width) * u64::from(height) > MAX_PIXELS {
            return Err(too_many_pixels());
        }

        let target = match (self.width, self.height) {
            (Some(w), Some(h)) => (w, h, self.resize),
            (Some(w), None) => (w, scale(height, w, width), Resize::Fill),
            (None, Some(h)) => (scale(width, h, height), h, Resize::Fill),
            (None, None) => (width, height, Resize::Fill),
        };
        let (w, h, mode) = target;
        let orientation = decoder.orientation().map_err(|_| decode_error())?;
        let swaps_dimensions = matches!(
            orientation,
            image::metadata::Orientation::Rotate90
                | image::metadata::Orientation::Rotate270
                | image::metadata::Orientation::Rotate90FlipH
                | image::metadata::Orientation::Rotate270FlipH
        );
        let (width, height) = if swaps_dimensions { (height, width) } else { (width, height) };
        let (w, h) = if self.width.is_none() && self.height.is_none() {
            (width, height)
        } else if matches!(mode, Resize::Contain) {
            (w.min(scale(width, h, height)), h.min(scale(height, w, width)))
        } else {
            (w, h)
        };
        if w > limits.max_dimension || h > limits.max_dimension {
            return Err(CanopyError::invalid_query(format!(
                "Output image dimensions cannot exceed {} pixels",
                limits.max_dimension
            )));
        }
        if u64::from(w) * u64::from(h) > MAX_PIXELS {
            return Err(too_many_pixels());
        }

        let mut pixels = DynamicImage::from_decoder(decoder).map_err(|_| decode_error())?;
        pixels.apply_orientation(orientation);
        if matches!(mode, Resize::Cover) {
            let crop_w = scale(height, w, h).min(width);
            let crop_h = scale(width, h, w).min(height);
            if (crop_w, crop_h) != (width, height) {
                pixels = pixels.crop_imm((width - crop_w) / 2, (height - crop_h) / 2, crop_w, crop_h);
            }
        }
        let pixels = resize(pixels, w, h);

        let mut encoded = Vec::new();
        let result = match format {
            Format::Jpeg => JpegEncoder::new_with_quality(&mut encoded, self.quality).encode_image(&pixels),
            Format::Png | Format::Avif => {
                let rgba = pixels.into_rgba8();
                if format == Format::Avif {
                    AvifEncoder::new_with_speed_quality(&mut encoded, 8, self.quality)
                        .with_num_threads(Some(1))
                        .write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
                } else {
                    PngEncoder::new(&mut encoded).write_image(
                        &rgba,
                        rgba.width(),
                        rgba.height(),
                        image::ExtendedColorType::Rgba8,
                    )
                }
            }
            _ => return Err(CanopyError::invalid_query("The image could not be transformed")),
        };
        result.map_err(|_| CanopyError::invalid_query("The image could not be transformed"))?;
        Ok(encoded)
    }
}

fn resize(pixels: DynamicImage, width: u32, height: u32) -> DynamicImage {
    if (pixels.width(), pixels.height()) == (width, height) {
        return pixels;
    }
    // image resamples vertically first. Swap axes when that pass would exceed the pixel budget.
    if u64::from(pixels.width()) * u64::from(height) > MAX_PIXELS {
        return pixels.rotate90().resize_exact(height, width, FILTER).rotate270();
    }
    pixels.resize_exact(width, height, FILTER)
}

fn scale(size: u32, target: u32, divisor: u32) -> u32 {
    let divisor = u64::from(divisor);
    let value = (u64::from(size) * u64::from(target) + divisor / 2) / divisor;
    u32::try_from(value.max(1)).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_large_gif_canvas_before_reading_any_frame() -> Result<(), CanopyError> {
        let transform = Transform::parse(|name| (name == "width").then(|| "2".to_owned()), 2500)?;
        let gif_header = b"GIF89a\x10\x27\x10\x27\x80\x00\x00\x00\x00\x00\xff\xff\xff,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02";
        let result = transform.encode(gif_header, "image/gif", ImageLimits::default());
        assert!(matches!(result, Err(error) if error.message() == too_many_pixels().message()));
        Ok(())
    }

    #[test]
    fn jpeg_quality_controls_encoding() -> Result<(), CanopyError> {
        let mut source = Vec::new();
        let pixels: Vec<_> = (0..(64 * 64 * 3)).map(|index| ((index * 37) % 251) as u8).collect();
        PngEncoder::new(&mut source)
            .write_image(&pixels, 64, 64, image::ExtendedColorType::Rgb8)
            .map_err(|_| decode_error())?;
        let encode = |quality: &str| {
            Transform::parse(
                |name| match name {
                    "format" => Some("jpeg".to_owned()),
                    "quality" => Some(quality.to_owned()),
                    _ => None,
                },
                2500,
            )?
            .encode(&source, "image/png", ImageLimits::default())
        };
        assert!(encode("20")?.len() < encode("95")?.len());
        Ok(())
    }

    #[test]
    fn bounds_both_explicit_and_inferred_output_dimensions() -> Result<(), CanopyError> {
        let limits = ImageLimits { max_dimension: 10, ..ImageLimits::default() };
        let result = Transform::parse(|name| (name == "width").then(|| "11".to_owned()), 10);
        assert!(
            matches!(result, Err(error) if error.message() == "width must be a whole number from 1 to 10")
        );

        let mut source = Vec::new();
        PngEncoder::new(&mut source)
            .write_image(&[0; 80], 1, 20, image::ExtendedColorType::Rgba8)
            .map_err(|_| decode_error())?;
        let transform = Transform::parse(|name| (name == "width").then(|| "10".to_owned()), 10)?;
        let result = transform.encode(&source, "image/png", limits);
        assert!(
            matches!(result, Err(error) if error.message() == "Output image dimensions cannot exceed 10 pixels")
        );
        assert!(check_source_size(32, 32).is_ok());
        assert!(matches!(check_source_size(33, 32), Err(error)
            if error.message() == "Images larger than 32 bytes cannot be transformed"));
        Ok(())
    }
}
