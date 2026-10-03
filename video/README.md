# Video tools (OpenMontage + weather product ad)

Free pipeline, no API keys. Works in a Claude cloud session whose environment
allows network access to github.com, huggingface.co, archive.org, pexels.com.

## Install (once per session, or put in the environment's Setup script)
    bash video/setup.sh

## Make the "rain -> snow -> sun" product ad (20 s, 9:16, with music)
    ~/openmontage/.venv/bin/python video/make_weather_ad.py photo.jpg out.mp4

Options: `--t1/--t2/--t3` (scene captions), `--end1/--end2` (closing lines),
`--crop CX CY CW CH` (9:16 window in source pixels; default is centered).
Render takes ~3 min.

## What it can't do
A person walking with the product needs AI image-to-video (paid: Higgsfield,
fal.ai/Kling, Veo). OpenMontage can then assemble those clips with music/captions.

## Free narration
    echo "Текст" | ~/openmontage/.venv/bin/piper --model ~/.piper/models/ru_RU-denis-medium.onnx --output_file voice.wav
