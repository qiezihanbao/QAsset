use image_hasher;

fn main() {
    // Create a dummy image for testing
    let img = image::RgbImage::new(100, 100);

    // Create hasher
    let hasher = image_hasher::HasherConfig::new()
        .hash_alg(image_hasher::HashAlg::Gradient)
        .to_hasher();

    // Hash the image
    let hash = hasher.hash_image(&img);

    // Check what methods are available
    println!("Hash type: {:?}", hash);

    // Try to convert to base64
    if let Ok(h) = hash {
        let base64 = h.to_base64();
        println!("Base64: {}", base64);
    }
}