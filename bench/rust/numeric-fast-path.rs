        // Same exact-number range, loop and fallback as the TypeScript sum.
        #[cfg(feature = "numeric-fast-path")]
        if n <= 300_000 {
            let mut total = 0.0f64;
            for i in 0..n as u32 {
                let i = i as f64;
                total += i * i;
            }
            let mut response = CallResponse::default();
            response.data = (total as u128).to_le_bytes().to_vec();
            return Ok(response);
        }
