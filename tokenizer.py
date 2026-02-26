from importlib.metadata import version
import tiktoken
print("tiktoken version: ", version("tiktoken"))

tokenizer = tiktoken.get_encoding("gpt2")
text = "Hello, do you like tea? <|endoftext|> In the sunlit terraces of someunknownPlace."
tokenizer_code = tokenizer.encode(text,allowed_special= {"<|endoftext|>"})
print(tokenizer_code)